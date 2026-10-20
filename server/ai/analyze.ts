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
import { buildRuleContext, schemaToText } from '../review/context';
import { runStaticReview } from '../review/static-review';
import { complete, stream, type ChatMessage, type ChatUsage } from './index';
import {
  buildAuditSummaryMessages,
  buildChatMessages,
  buildRepairMessages,
  buildReviewMessages,
} from './prompts';

const AiFindingSchema = z
  .object({
    severity: z.string().nullish(),
    category: z.string().nullish(),
    title: z.string().nullish(),
    detail: z.string().nullish(),
    message: z.string().nullish(),
    recommendation: z.string().nullish(),
    line: z.number().nullish(),
    evidence: z.string().nullish(),
    table: z.string().nullish(),
    column: z.string().nullish(),
  })
  .passthrough();

const AiRewriteSchema = z
  .object({
    sql: z.string(),
    explanation: z.string().nullish(),
  })
  .passthrough();

const AiReviewSchema = z
  .object({
    verdict: z.string().nullish(),
    score: z.number().nullish(),
    summary: z.string().nullish(),
    findings: z.array(AiFindingSchema).nullish(),
    rewrite: AiRewriteSchema.nullish(),
  })
  .passthrough();

interface ParsedAiReview {
  verdict: AiReview['verdict'];
  score: number | null;
  summary: string;
  findings: Finding[];
  rewrite: AiReview['rewrite'];
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
  return SEVERITY_MAP[String(value ?? '').trim().toLowerCase()] ?? 'medium';
}

function normalizeCategory(value: string | null | undefined): FindingCategory {
  return CATEGORY_MAP[String(value ?? '').trim().toLowerCase()] ?? 'correctness';
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
  if (!parsedRaw) return null;
  const container = parsedRaw as Record<string, unknown>;
  const candidate =
    container.review && typeof container.review === 'object'
      ? container.review
      : container;
  const parsed = AiReviewSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const findings: Finding[] = [];
  for (const raw of parsed.data.findings ?? []) {
    const title = (raw.title ?? '').trim() || 'AI review finding';
    const severity = normalizeSeverity(raw.severity);
    const category = normalizeCategory(raw.category);
    const message =
      (raw.detail ?? raw.message ?? '').trim() ||
      title;
    const line =
      raw.line != null && Number.isFinite(raw.line) && raw.line >= 1
        ? Math.trunc(raw.line)
        : null;
    findings.push({
      id: crypto.randomUUID(),
      ruleId: `ai.${slugify(title)}`,
      title,
      severity,
      category,
      message,
      recommendation:
        (raw.recommendation ?? '').trim() ||
        'Review the suggestion against the schema and verify it with EXPLAIN before changing production code.',
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
  } else if (findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high')) {
    verdict = 'fail';
  } else if (findings.some((finding) => finding.severity === 'medium' || finding.severity === 'low')) {
    verdict = 'warn';
  } else {
    verdict = 'pass';
  }

  const score =
    parsed.data.score != null && Number.isFinite(parsed.data.score)
      ? Math.max(0, Math.min(100, Math.round(parsed.data.score)))
      : null;

  const summary = (parsed.data.summary ?? '').trim() || 'AI review completed.';
  const rewriteSql = parsed.data.rewrite?.sql?.trim();
  const rewrite =
    rewriteSql && rewriteSql.length <= 50_000
      ? {
          sql: rewriteSql,
          explanation:
            (parsed.data.rewrite?.explanation ?? '').trim() ||
            'The reviewer suggested this rewrite.',
        }
      : null;

  return { verdict, score, summary, findings, rewrite };
}

function usageToShared(usage: ChatUsage | null): AiReview['usage'] {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function aiReviewFrom(
  parsed: ParsedAiReview | null,
  raw: string,
  provider: AiProvider,
  usage: ChatUsage | null,
  durationMs: number,
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
    };
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
  };
}

async function schemaTextFor(
  profileId: string | null | undefined,
  database: string | null | undefined,
  sql: string,
  server: ServerInfo | null,
): Promise<{ text: string; truncated: boolean }> {
  if (!profileId || !database) return { text: '', truncated: false };
  try {
    await assertDatabaseAllowed(profileId, database);
    const settings = await getSettings();
    const snapshot = await getSchemaSnapshot(profileId, database);
    const context = buildRuleContext({
      sql,
      database,
      schema: snapshot,
      server,
    });
    const text = schemaToText(context.tables, settings.aiContextChars);
    return {
      text,
      truncated: text.endsWith('-- [schema context truncated]'),
    };
  } catch {
    return { text: '', truncated: false };
  }
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
): Promise<AiReviewRunResult> {
  const started = Date.now();
  if (request.profileId) {
    await assertSqlScope(request.profileId, request.sql, request.database ?? null);
  }
  const server = request.profileId ? getCachedServerInfo(request.profileId) : null;

  let findings = request.findings ?? [];
  let explain: ExplainResult | null = request.explain ?? null;
  if (!request.findings || (request.includeExplain && !request.explain)) {
    try {
      const staticResult = await runStaticReview({
        profileId: request.profileId,
        database: request.database,
        sql: request.sql,
        includeSchema: request.includeSchema !== false,
        includeExplain: Boolean(request.includeExplain),
        analyze: Boolean(request.analyze),
      });
      if (!request.findings) findings = staticResult.findings;
      if (!explain) explain = staticResult.explain;
    } catch {
      // AI review can continue without deterministic findings.
    }
  }

  const schema = await schemaTextFor(
    request.profileId,
    request.database,
    request.sql,
    server,
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

  let raw = '';
  let usage: ChatUsage | null = null;
  let sawDelta = false;
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
    if (!sawDelta && provider.streaming) {
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
  if (!parsed && raw.trim()) {
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
        }
      }
    } catch {
      // Fall back to the markdown response.
    }
  }

  return {
    review: aiReviewFrom(parsed, raw, provider, usage, Date.now() - started),
    raw,
  };
}

export async function runAiChat(
  request: AiChatRequest,
  provider: AiProvider,
  apiKey: string | null,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; usage: ChatUsage | null }> {
  const context = request.context;
  if (context?.profileId) {
    if (context.database) {
      await assertDatabaseAllowed(context.profileId, context.database);
    }
    if (context.sql) {
      await assertSqlScope(context.profileId, context.sql, context.database ?? null);
    }
  }
  const server =
    context?.profileId ? getCachedServerInfo(context.profileId) : null;
  const schema = await schemaTextFor(
    context?.profileId,
    context?.database,
    context?.sql ?? '',
    server,
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
