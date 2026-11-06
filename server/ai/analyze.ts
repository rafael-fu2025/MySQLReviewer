import crypto from 'node:crypto';
import { z } from 'zod';
import type {
  AiChatRequest,
  AiProvider,
  AiReview,
  AiReviewRequest,
  AuditEnvironment,
  AuditStats,
  ExplainResult,
  Finding,
  FindingCategory,
  FindingGroup,
  ScoreResult,
  ServerInfo,
} from '../../shared/types';
import { getSettings } from '../store/settings';
import { getCachedServerInfo } from '../db/manager';
import { getSchemaSnapshot } from '../db/introspection';
import { assertDatabaseAllowed, assertSqlScope } from '../db/scope';
import { AppError } from '../errors';
import { buildRuleContext, schemaToText } from '../review/context';
import { runStaticReview } from '../review/static-review';
import { complete, stream, type ChatMessage, type ChatUsage } from './index';
import {
  buildAuditSummaryMessages,
  buildChatMessages,
  buildRepairMessages,
  buildReviewMessages,
} from './prompts';

/**
 * A model answer is data, not code: one field of the wrong type must not throw
 * the whole review away. Every field is therefore coerced to the shape the
 * parser expects, and a value that cannot be coerced becomes `null` instead of
 * failing the parse.
 */
function coerceText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A line number: the model often quotes it as a string ("12"). */
function coerceLine(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const AiTextSchema = z.preprocess(coerceText, z.string().nullish());
const AiNumberSchema = z.preprocess(coerceNumber, z.number().nullish());
const AiLineSchema = z.preprocess(coerceLine, z.number().nullish());

const AiFindingSchema = z
  .object({
    severity: AiTextSchema,
    category: AiTextSchema,
    title: AiTextSchema,
    detail: AiTextSchema,
    message: AiTextSchema,
    recommendation: AiTextSchema,
    line: AiLineSchema,
    evidence: AiTextSchema,
    table: AiTextSchema,
    column: AiTextSchema,
  })
  .passthrough();

const AiRewriteSchema = z
  .object({
    sql: AiTextSchema,
    explanation: AiTextSchema,
  })
  .passthrough();

/** A rewrite that is a bare SQL string is accepted; a rewrite without SQL is dropped. */
const AiRewriteField = z.preprocess((value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return { sql: value };
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}, AiRewriteSchema.nullish());

/** Findings that are not objects cannot be findings: they are dropped, not fatal. */
const AiFindingsSchema = z.preprocess((value) => {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
}, z.array(AiFindingSchema).nullish());

const AiReviewSchema = z
  .object({
    verdict: AiTextSchema,
    score: AiNumberSchema,
    summary: AiTextSchema,
    findings: AiFindingsSchema,
    rewrite: AiRewriteField,
  })
  .passthrough();

/** The fields that make a JSON object a review rather than something else. */
const REVIEW_FIELDS = ['verdict', 'score', 'summary', 'findings', 'rewrite'] as const;

function looksLikeReview(value: Record<string, unknown>): boolean {
  return REVIEW_FIELDS.some((field) => value[field] !== undefined);
}

/**
 * How many findings of one provider answer are kept. The provider body is byte
 * capped, but the item count is not, so a long answer must not turn into an
 * unbounded finding list.
 */
export const MAX_AI_FINDINGS = 200;

interface ParsedAiReview {
  verdict: AiReview['verdict'];
  score: number | null;
  summary?: string;
  findings: Finding[];
  rewrite: AiReview['rewrite'];
  /** True when the provider sent more findings than were kept. */
  findingsTruncated: boolean;
  /** How many findings the provider sent. */
  findingsTotal: number;
}

const SEVERITY_MAP: Record<string, Finding['severity']> = {
  critical: 'critical',
  blocker: 'critical',
  high: 'high',
  error: 'high',
  medium: 'medium',
  warning: 'medium',
  warn: 'medium',
  low: 'low',
  minor: 'low',
  info: 'info',
  informational: 'info',
  note: 'info',
};

const CATEGORY_MAP: Record<string, FindingCategory> = {
  correctness: 'correctness',
  correct: 'correctness',
  bug: 'correctness',
  performance: 'performance',
  perf: 'performance',
  security: 'security',
  schema: 'schema',
  config: 'config',
  configuration: 'config',
  style: 'style',
  maintainability: 'maintainability',
  maintainable: 'maintainability',
};

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'finding'
  );
}

function normalizeSeverity(value: string | null | undefined): Finding['severity'] {
  return (
    SEVERITY_MAP[
      String(value ?? '')
        .trim()
        .toLowerCase()
    ] ?? 'medium'
  );
}

function normalizeCategory(value: string | null | undefined): FindingCategory {
  return (
    CATEGORY_MAP[
      String(value ?? '')
        .trim()
        .toLowerCase()
    ] ?? 'correctness'
  );
}

export function extractJsonObject(text: string): unknown | null {
  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseAiReview(text: string): ParsedAiReview | null {
  const parsedRaw = extractJsonObject(text);
  if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) return null;
  const container = parsedRaw as Record<string, unknown>;
  const candidate =
    container.review && typeof container.review === 'object' && !Array.isArray(container.review)
      ? (container.review as Record<string, unknown>)
      : container;
  // The shape stays strict at the top level: an object that is not a review at
  // all is rejected instead of being shown as an empty, passing review.
  if (!looksLikeReview(candidate)) return null;
  const parsed = AiReviewSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const rawFindings = parsed.data.findings ?? [];
  const findings: Finding[] = [];
  for (const raw of rawFindings) {
    if (findings.length >= MAX_AI_FINDINGS) break;
    const title = (raw.title ?? '').trim() || 'AI review finding';
    const severity = normalizeSeverity(raw.severity);
    const category = normalizeCategory(raw.category);
    const message = (raw.detail ?? raw.message ?? '').trim() || title;
    const line =
      raw.line != null && Number.isFinite(raw.line) && raw.line >= 1 ? Math.trunc(raw.line) : null;
    findings.push({
      id: crypto.randomUUID(),
      ruleId: `ai.${slugify(title)}`,
      title,
      severity,
      category,
      message,
      recommendation: (raw.recommendation ?? '').trim() || undefined,
      evidence: (raw.evidence ?? '').trim() || undefined,
      line,
      column: null,
      object:
        raw.table || raw.column
          ? {
              table: raw.table ? String(raw.table) : undefined,
              column: raw.column ? String(raw.column) : undefined,
            }
          : undefined,
      source: 'ai',
      confidence: 'medium',
    });
  }

  let verdict: AiReview['verdict'];
  const rawVerdict = String(parsed.data.verdict ?? '').toLowerCase();
  if (rawVerdict === 'pass' || rawVerdict === 'warn' || rawVerdict === 'fail') {
    verdict = rawVerdict;
  } else if (
    findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high')
  ) {
    verdict = 'fail';
  } else if (
    findings.some((finding) => finding.severity === 'medium' || finding.severity === 'low')
  ) {
    verdict = 'warn';
  } else {
    verdict = 'pass';
  }

  const score =
    parsed.data.score != null && Number.isFinite(parsed.data.score)
      ? Math.max(0, Math.min(100, Math.round(parsed.data.score)))
      : null;

  const summary = (parsed.data.summary ?? '').trim() || undefined;
  const rewriteSql = parsed.data.rewrite?.sql?.trim();
  const rewrite =
    rewriteSql && rewriteSql.length <= 50_000
      ? {
          sql: rewriteSql,
          explanation: (parsed.data.rewrite?.explanation ?? '').trim() || undefined,
        }
      : null;

  return {
    verdict,
    score,
    summary,
    findings,
    rewrite,
    findingsTruncated: rawFindings.length > findings.length,
    findingsTotal: rawFindings.length,
  };
}

function usageToShared(usage: ChatUsage | null): AiReview['usage'] {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

/** What the caller has to know about the provider calls that produced a review. */
export interface AiReviewCallInfo {
  /** A second, billable request was made to repair an unparsable answer. */
  repairAttempted: boolean;
  /** A second, billable request was made because the streaming call failed. */
  streamingFallback: boolean;
  /** Non-fatal problems the caller should see. */
  warnings: string[];
}

function aiReviewFrom(
  parsed: ParsedAiReview | null,
  raw: string,
  provider: AiProvider,
  usage: ChatUsage | null,
  durationMs: number,
  call: AiReviewCallInfo,
): AiReview {
  if (!parsed) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      verdict: 'unknown',
      score: null,
      summary: raw.slice(0, 500) || 'The provider returned an empty response.',
      findings: [],
      rewrite: null,
      markdown: raw,
      usage: usageToShared(usage),
      durationMs,
      repairAttempted: call.repairAttempted,
      streamingFallback: call.streamingFallback,
      warnings: call.warnings.length > 0 ? call.warnings : undefined,
    };
  }
  const warnings = [...call.warnings];
  if (parsed.findingsTruncated) {
    warnings.push(
      `The provider returned ${parsed.findingsTotal} findings; only the first ${parsed.findings.length} are shown.`,
    );
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    model: provider.model,
    verdict: parsed.verdict,
    score: parsed.score,
    summary: parsed.summary,
    findings: parsed.findings,
    rewrite: parsed.rewrite,
    markdown: raw,
    usage: usageToShared(usage),
    durationMs,
    repairAttempted: call.repairAttempted,
    streamingFallback: call.streamingFallback,
    findingsTruncated: parsed.findingsTruncated,
    findingsTotal: parsed.findingsTotal,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export interface AiScopeOptions {
  /** Narrows a member session to their sandbox databases. */
  scopeOverride?: { allowed: string[] };
}

export async function schemaTextFor(
  profileId: string | null | undefined,
  database: string | null | undefined,
  sql: string,
  scopeOverride?: { allowed: string[] },
): Promise<{ text: string; truncated: boolean; error?: string }> {
  if (!profileId || !database) return { text: '', truncated: false };
  try {
    await assertDatabaseAllowed(profileId, database, scopeOverride);
    const settings = await getSettings();
    const snapshot = await getSchemaSnapshot(profileId, database);
    const context = buildRuleContext({
      sql,
      schema: snapshot,
    });
    const text = schemaToText(context.tables, settings.aiContextChars);
    return {
      text,
      truncated: text.endsWith('-- [schema context truncated]'),
    };
  } catch (error) {
    // A schema that could not be read is not an empty schema: the failure is
    // reported so the review cannot pass for a schema-aware review.
    return {
      text: '',
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Provider failures a second request cannot fix. Every fallback or repair call
 * is billed again, so it is only worth making when the failure could plausibly
 * be specific to the first attempt.
 */
const NON_RETRYABLE_AI_CODES = new Set([
  'AI_CANCELLED',
  'AI_AUTH',
  'AI_RATE_LIMIT',
  'AI_BUSY',
  'AI_BAD_REQUEST',
  'AI_RESPONSE_TOO_LARGE',
]);

/**
 * Whether a failed streaming call is worth a second (billable) non-streaming
 * call. A cancelled request, a rejected key, a rate limit or a busy server
 * fails the same way the second time, so those failures are not retried.
 */
export function isRetryableStreamFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (error instanceof AppError && NON_RETRYABLE_AI_CODES.has(error.code)) return false;
  return true;
}

export interface AiReviewRunResult {
  review: AiReview;
  raw: string;
}

export async function runAiReview(
  request: AiReviewRequest,
  provider: AiProvider,
  apiKey: string | null,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  options: AiScopeOptions = {},
): Promise<AiReviewRunResult> {
  const started = Date.now();
  const scopeOverride = options.scopeOverride;
  if (request.profileId) {
    await assertSqlScope(request.profileId, request.sql, request.database ?? null, scopeOverride);
  }
  const server = request.profileId ? getCachedServerInfo(request.profileId) : null;

  let findings = request.findings ?? [];
  let explain: ExplainResult | null = request.explain ?? null;
  // Declared before the deterministic pass so that a failure there can be
  // reported rather than silently swallowed.
  const warnings: string[] = [];
  if (!request.findings || (request.includeExplain && !request.explain)) {
    try {
      const staticResult = await runStaticReview({
        profileId: request.profileId,
        database: request.database,
        sql: request.sql,
        includeSchema: request.includeSchema !== false,
        includeExplain: Boolean(request.includeExplain),
        analyze: Boolean(request.analyze),
        scopeOverride,
      });
      if (!request.findings) findings = staticResult.findings;
      if (!explain) explain = staticResult.explain;
    } catch (error) {
      // The AI review can continue without deterministic findings, but it must
      // say so: an empty finding set silently presented reads as "no issues".
      warnings.push(
        `The deterministic review could not be completed (${
          error instanceof Error ? error.message : String(error)
        }), so this review is based on the AI answer alone.`,
      );
    }
  }

  const schema = await schemaTextFor(
    request.profileId,
    request.database,
    request.sql,
    scopeOverride,
  );

  const messages = buildReviewMessages({
    sql: request.sql,
    server,
    database: request.database ?? null,
    schemaText: schema.text,
    schemaTruncated: schema.truncated,
    findings,
    explain,
  });

  let raw: string;
  let usage: ChatUsage | null;
  let sawDelta = false;
  let repairAttempted = false;
  let streamingFallback = false;
  const handleDelta = (delta: string): void => {
    sawDelta = true;
    onDelta(delta);
  };

  try {
    if (provider.streaming) {
      const result = await stream(
        provider,
        apiKey,
        messages,
        { onDelta: handleDelta },
        { temperature: provider.temperature, maxTokens: provider.maxTokens, signal },
      );
      raw = result.text;
      usage = result.usage;
    } else {
      const result = await complete(provider, apiKey, messages, {
        temperature: provider.temperature,
        maxTokens: provider.maxTokens,
        signal,
      });
      raw = result.text;
      usage = result.usage;
      if (raw) handleDelta(raw);
    }
  } catch (error) {
    // The fallback is a second provider call and therefore a second bill: it
    // is only made when the failure could be specific to the streaming call.
    if (!sawDelta && provider.streaming && isRetryableStreamFailure(error, signal)) {
      streamingFallback = true;
      warnings.push(
        'The streaming request failed, so the answer was fetched with a second provider call, which was billed again.',
      );
      const result = await complete(provider, apiKey, messages, {
        temperature: provider.temperature,
        maxTokens: provider.maxTokens,
        signal,
      });
      raw = result.text;
      usage = result.usage;
      if (raw) handleDelta(raw);
    } else {
      throw error;
    }
  }

  let parsed = parseAiReview(raw);
  if (!parsed && raw.trim() && !signal?.aborted) {
    // A repair round trip is a second bill: it is skipped once the request was
    // cancelled and it is reported when it happens. The repair request carries
    // the broken answer, not the schema and the SQL again.
    repairAttempted = true;
    try {
      const repair = await complete(provider, apiKey, buildRepairMessages(messages, raw), {
        temperature: 0,
        maxTokens: provider.maxTokens,
        signal,
      });
      if (repair.text) {
        const repaired = parseAiReview(repair.text);
        if (repaired) {
          parsed = repaired;
          raw = repair.text;
          usage = repair.usage ?? usage;
          warnings.push(
            'The provider answer was not a valid review and was repaired with a second provider call, which was billed again.',
          );
        }
      }
    } catch {
      // Fall back to the markdown response.
    }
  }
  if (!parsed && raw.trim()) {
    warnings.push('The provider answer could not be parsed as a review.');
  }
  if (schema.error) {
    warnings.push(
      `The schema could not be read (${schema.error}), so this review is based on the SQL alone.`,
    );
  }

  return {
    review: aiReviewFrom(parsed, raw, provider, usage, Date.now() - started, {
      repairAttempted,
      streamingFallback,
      warnings,
    }),
    raw,
  };
}

export async function runAiChat(
  request: AiChatRequest,
  provider: AiProvider,
  apiKey: string | null,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  options: AiScopeOptions = {},
): Promise<{ text: string; usage: ChatUsage | null }> {
  const context = request.context;
  const scopeOverride = options.scopeOverride;
  if (context?.profileId) {
    if (context.database) {
      await assertDatabaseAllowed(context.profileId, context.database, scopeOverride);
    }
    if (context.sql) {
      await assertSqlScope(context.profileId, context.sql, context.database ?? null, scopeOverride);
    }
  }
  const server = context?.profileId ? getCachedServerInfo(context.profileId) : null;
  const schema = await schemaTextFor(
    context?.profileId,
    context?.database,
    context?.sql ?? '',
    scopeOverride,
  );
  const messages = buildChatMessages({
    messages: request.messages,
    sql: context?.sql,
    database: context?.database ?? null,
    server,
    schemaText: schema.text,
  });

  if (provider.streaming) {
    const result = await stream(
      provider,
      apiKey,
      messages,
      { onDelta },
      { temperature: provider.temperature, maxTokens: provider.maxTokens, signal },
    );
    return { text: result.text, usage: result.usage };
  }
  const result = await complete(provider, apiKey, messages, {
    temperature: provider.temperature,
    maxTokens: provider.maxTokens,
    signal,
  });
  if (result.text) onDelta(result.text);
  return { text: result.text, usage: result.usage };
}

export interface AuditSummaryInput {
  databases: string[];
  server: ServerInfo | null;
  score: ScoreResult;
  stats: AuditStats;
  environment: AuditEnvironment;
  groups: FindingGroup[];
}

export async function runAuditSummary(
  input: AuditSummaryInput,
  provider: AiProvider,
  apiKey: string | null,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; usage: ChatUsage | null }> {
  const messages = buildAuditSummaryMessages(input);
  if (provider.streaming) {
    const result = await stream(
      provider,
      apiKey,
      messages,
      { onDelta },
      { temperature: provider.temperature, maxTokens: provider.maxTokens, signal },
    );
    return { text: result.text, usage: result.usage };
  }
  const result = await complete(provider, apiKey, messages, {
    temperature: provider.temperature,
    maxTokens: provider.maxTokens,
    signal,
  });
  if (result.text) onDelta(result.text);
  return { text: result.text, usage: result.usage };
}

export type { ChatMessage };
