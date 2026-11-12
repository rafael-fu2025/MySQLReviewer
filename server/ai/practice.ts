import crypto from 'node:crypto';
import { z } from 'zod';
import type {
  AiProvider,
  DatabaseObjects,
  Finding,
  PracticeDifficulty,
  PracticeEvaluation,
  PracticeGenerateRequest,
  PracticeHintLadder,
  PracticeQuestion,
  PracticeSet,
  PracticeTopic,
  PracticeScores,
  QueryResult,
} from '../../shared/types';
import { PRACTICE_TOPICS } from '../../shared/types';
import { AppError } from '../errors';
import { getSettings } from '../store/settings';
import { getCachedServerInfo } from '../db/manager';
import { getDatabaseObjects, getSchemaSnapshot, getTableData } from '../db/introspection';
import { assertDatabaseAllowed, assertSqlScope } from '../db/scope';
import { maskResultRows } from '../db/masking';
import { estimateBytes } from '../db/serialize';
import { schemaToText } from '../review/context';
import { runStaticReview } from '../review/static-review';
import { runExplain } from '../db/explain';
import { classifySql } from '../review/sql-classifier';
import { executeQuery } from '../db/query';
import {
  comparePracticeResults,
  filterPracticeHintLadder,
  isSamePracticeSubmission,
  maskPracticeComparison,
  practiceVerdict,
  scorePractice,
  validateReferenceSql,
} from '../db/practice';
import {
  addPracticeAttempt,
  getOwnedPracticeSet,
  listPracticeAttemptsForSet,
  recordPracticeReviewOutcome,
  savePracticeSet,
} from '../store/practice';
import { complete, stream, type ChatMessage } from './index';
import { extractJsonObject } from './analyze';
import {
  buildPracticeEvaluationMessages,
  buildPracticeGenerationMessages,
} from './practice-prompts';

/**
 * A repair round trip is a second billable provider call, so it has to stay
 * small: only the system prompt (which carries the required JSON shape) and
 * the unparsable answer are resent. The schema, the sample data and the SQL
 * context are dropped.
 */
export function buildPracticeRepairMessages(
  original: ChatMessage[],
  raw: string,
  shape: string,
): ChatMessage[] {
  const system = original.find((message) => message.role === 'system');
  return [
    ...(system ? [system] : []),
    { role: 'assistant', content: raw.slice(0, 20_000) },
    {
      role: 'user',
      content: `Your previous response was not valid JSON. Return the same ${shape} again as exactly one JSON object matching the required shape. Start with { and end with }. No markdown fences, no prose.`,
    },
  ];
}

const PRACTICE_TOPIC_IDS = new Set(PRACTICE_TOPICS.map((topic) => topic.id));

const QuestionSchema = z
  .object({
    type: z.enum(['write-query', 'fix-query', 'review-query', 'concept']),
    title: z.string().min(1).max(180),
    scenario: z.string().min(1).max(6_000),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    topics: z.array(z.string()).optional(),
    tables: z.array(z.string()).optional(),
    brokenSql: z.string().nullish(),
    referenceSql: z.string().nullish(),
    expectedResult: z.string().nullish(),
    orderMatters: z.boolean().optional(),
    hints: z.array(z.string()).optional(),
    hintLadder: z
      .object({
        nudge: z.string().optional(),
        approach: z.string().optional(),
        skeleton: z.string().optional(),
      })
      .passthrough()
      .optional(),
    estimatedMinutes: z.number().optional(),
    execute: z.boolean().optional(),
  })
  .passthrough();

/**
 * Hard bounds for a stored practice question. The prompt asks the model to be
 * brief, but the store must not grow with whatever the model answered, so
 * every free-text field and every list is bounded before it is written.
 */
export const PRACTICE_STORAGE_LIMITS = {
  title: 180,
  scenario: 6_000,
  brokenSql: 20_000,
  referenceSql: 20_000,
  expectedResult: 6_000,
  hint: 2_000,
  hints: 10,
  topic: 64,
  topics: 14,
  table: 128,
  tables: 20,
} as const;

function boundText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * SQL is cut at a statement boundary when there is one, so a bounded statement
 * stays a statement.
 */
function boundSql(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSemicolon = cut.lastIndexOf(';');
  if (lastSemicolon > 0) return cut.slice(0, lastSemicolon + 1);
  return cut;
}

function boundList(values: string[] | undefined, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((item) => typeof item === 'string')
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}

/**
 * Bounds the hint ladder tiers with the hint cap and runs the leak filter per
 * tier. The skeleton tier legitimately holds SQL-ish fragments, so it gets the
 * filter as-is: a skeleton that trips it is dropped while tiers 1–2 survive.
 * Tiers the model omitted or that leak are absent, and an empty ladder is not
 * stored at all.
 */
function boundHintLadder(
  ladder: PracticeHintLadder | null | undefined,
  tables: string[],
): PracticeHintLadder | undefined {
  if (!ladder) return undefined;
  const bounded: PracticeHintLadder = {
    nudge: boundText(ladder.nudge, PRACTICE_STORAGE_LIMITS.hint)?.trim() || undefined,
    approach: boundText(ladder.approach, PRACTICE_STORAGE_LIMITS.hint)?.trim() || undefined,
    skeleton: boundText(ladder.skeleton, PRACTICE_STORAGE_LIMITS.hint)?.trim() || undefined,
  };
  return filterPracticeHintLadder(bounded, tables);
}

/**
 * Applies the storage bounds to a generated question. The prompt-level limits
 * are a request, this is the guarantee: a huge or hostile model answer cannot
 * bloat the practice store.
 */
export function boundPracticeQuestion(question: {
  title: string;
  scenario: string;
  brokenSql?: string | null;
  referenceSql?: string | null;
  expectedResult?: string | null;
  hints?: string[];
  hintLadder?: PracticeHintLadder | null;
  topics?: string[];
  tables?: string[];
}): {
  title: string;
  scenario: string;
  brokenSql: string | null;
  referenceSql: string | null;
  expectedResult: string | null;
  hints: string[];
  hintLadder?: PracticeHintLadder;
  topics: string[];
  tables: string[];
} {
  // When the model produced a ladder, the flat hints stay the union of the
  // surviving tiers in order, so old clients keep seeing a progressive list.
  const hintLadder = boundHintLadder(question.hintLadder, question.tables ?? []);
  const tierHints = hintLadder
    ? (['nudge', 'approach', 'skeleton'] as const)
        .map((tier) => hintLadder[tier])
        .filter((tier): tier is string => typeof tier === 'string')
    : [];
  return {
    title: boundText(question.title, PRACTICE_STORAGE_LIMITS.title) ?? '',
    scenario: boundText(question.scenario, PRACTICE_STORAGE_LIMITS.scenario) ?? '',
    brokenSql: boundSql(question.brokenSql, PRACTICE_STORAGE_LIMITS.brokenSql),
    referenceSql: boundSql(question.referenceSql, PRACTICE_STORAGE_LIMITS.referenceSql),
    expectedResult: boundText(question.expectedResult, PRACTICE_STORAGE_LIMITS.expectedResult),
    hints:
      tierHints.length > 0
        ? tierHints
        : boundList(question.hints, PRACTICE_STORAGE_LIMITS.hints, PRACTICE_STORAGE_LIMITS.hint),
    hintLadder,
    topics: boundList(
      question.topics,
      PRACTICE_STORAGE_LIMITS.topics,
      PRACTICE_STORAGE_LIMITS.topic,
    ),
    tables: boundList(
      question.tables,
      PRACTICE_STORAGE_LIMITS.tables,
      PRACTICE_STORAGE_LIMITS.table,
    ),
  };
}

const GenerationSchema = z
  .object({
    summary: z.string().nullish(),
    questions: z.array(QuestionSchema).min(1).max(30),
  })
  .passthrough();

const EvaluationSchema = z
  .object({
    correctness: z.number().min(0).max(100).optional(),
    performance: z.number().min(0).max(100).optional(),
    style: z.number().min(0).max(100).optional(),
    summary: z.string().optional(),
    strengths: z.array(z.string()).optional(),
    issues: z.array(z.string()).optional(),
    nextHint: z.string().optional(),
    feedback: z.string().optional(),
  })
  .passthrough();

interface ParsedGeneration {
  summary: string;
  questions: z.infer<typeof QuestionSchema>[];
}

function parseGeneration(text: string): ParsedGeneration | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  const parsed = GenerationSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    summary: (parsed.data.summary ?? '').trim(),
    questions: parsed.data.questions,
  };
}

interface ParsedEvaluation {
  correctness?: number;
  performance?: number;
  style?: number;
  summary?: string;
  strengths: string[];
  issues: string[];
  nextHint?: string;
  feedback?: string;
}

function parseEvaluation(text: string): ParsedEvaluation | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  const parsed = EvaluationSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    correctness: parsed.data.correctness,
    performance: parsed.data.performance,
    style: parsed.data.style,
    summary: parsed.data.summary?.trim(),
    strengths: (parsed.data.strengths ?? []).map((item) => item.trim()).filter(Boolean),
    issues: (parsed.data.issues ?? []).map((item) => item.trim()).filter(Boolean),
    nextHint: parsed.data.nextHint?.trim(),
    feedback: parsed.data.feedback?.trim(),
  };
}

function normalizeTopics(topics: string[] | undefined, fallback: PracticeTopic[]): PracticeTopic[] {
  const values = (topics ?? [])
    .map((topic) => topic.trim().toLowerCase())
    .filter((topic): topic is PracticeTopic => PRACTICE_TOPIC_IDS.has(topic as PracticeTopic));
  return values.length > 0 ? Array.from(new Set(values)) : fallback;
}

function normalizeDifficulty(
  value: PracticeDifficulty | undefined,
  fallback: PracticeDifficulty,
): PracticeDifficulty {
  return value ?? fallback;
}

function questionKind(type: PracticeQuestion['type']): {
  executableCandidate: boolean;
  needsBrokenSql: boolean;
} {
  return {
    executableCandidate: type === 'write-query' || type === 'fix-query',
    needsBrokenSql: type === 'fix-query' || type === 'review-query',
  };
}

export interface PracticeScopeOptions {
  /** The authenticated account that owns every generated artifact. */
  userId: string;
  /** Narrows a member session to their sandbox databases. */
  scopeOverride?: { allowed: string[] };
}

export interface PracticeGenerationOptions extends PracticeScopeOptions {
  /** Cancels provider calls, including the repair round trip. */
  signal?: AbortSignal;
}

function programmableObjectsText(objects: DatabaseObjects, maxChars: number): string {
  const parts: string[] = [];
  if (objects.views.length > 0) {
    parts.push('VIEWS:');
    for (const view of objects.views.slice(0, 10)) {
      const def = view.definition ? `\n    ${view.definition.slice(0, 300)}` : '';
      parts.push(`  VIEW ${view.name} (updatable=${view.updatable}):${def}`);
    }
  }
  if (objects.routines.length > 0) {
    parts.push('ROUTINES (STORED PROCEDURES & FUNCTIONS):');
    for (const routine of objects.routines.slice(0, 10)) {
      const params = routine.parameters ? `(${routine.parameters})` : '()';
      const returns = routine.returnType ? ` RETURNS ${routine.returnType}` : '';
      const body = routine.body ? `\n    ${routine.body.slice(0, 300)}` : '';
      parts.push(`  ${routine.type} ${routine.name}${params}${returns}${body}`);
    }
  }
  if (objects.triggers.length > 0) {
    parts.push('TRIGGERS:');
    for (const trigger of objects.triggers.slice(0, 10)) {
      const stmt = trigger.statement ? `\n    ${trigger.statement.slice(0, 300)}` : '';
      parts.push(
        `  TRIGGER ${trigger.name} ${trigger.timing} ${trigger.event} ON ${trigger.table}${stmt}`,
      );
    }
  }
  if (parts.length === 0) return '';
  let text = '\n\n' + parts.join('\n');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n-- [programmable objects truncated]';
  }
  return text;
}

async function schemaTextForTables(
  profileId: string,
  database: string,
  tables: string[],
  maxChars: number,
  scopeOverride?: { allowed: string[] },
): Promise<{ text: string; includedTables: string[] }> {
  // The schema is a read of the named database: it has to be in scope.
  await assertDatabaseAllowed(profileId, database, scopeOverride);
  const snapshot = await getSchemaSnapshot(profileId, database);
  const selected =
    tables.length > 0
      ? snapshot.tables.filter((table) => tables.includes(table.name))
      : snapshot.tables
          .slice()
          .sort((a, b) => b.rowsEstimate - a.rowsEstimate)
          .slice(0, 20);

  const baseText = schemaToText(selected, maxChars);
  let extraText = '';
  try {
    const remaining = maxChars - baseText.length;
    if (remaining > 500) {
      const objects = await getDatabaseObjects(profileId, database);
      extraText = programmableObjectsText(objects, remaining);
    }
  } catch {
    // Reading views, routines, or triggers is best-effort.
  }

  return {
    text: baseText + extraText,
    includedTables: selected.map((table) => table.name),
  };
}

async function sampleDataText(
  profileId: string,
  database: string,
  tables: string[],
): Promise<string> {
  const blocks: string[] = [];
  for (const table of tables.slice(0, 10)) {
    try {
      const data = await getTableData(profileId, database, table, { limit: 5 });
      blocks.push(
        `TABLE ${table} (up to 5 rows, sensitive values masked):\nCOLUMNS: ${data.columns.map((column) => column.name).join(', ')}\nROWS: ${JSON.stringify(data.rows.slice(0, 5))}`,
      );
    } catch {
      // A missing table should not stop the set.
    }
  }
  return blocks.join('\n\n');
}

export interface PracticeGenerationRunResult {
  set: PracticeSet;
  raw: string;
}

export async function generatePracticeSet(
  request: PracticeGenerateRequest,
  provider: AiProvider,
  apiKey: string | null,
  onDelta: (text: string) => void,
  options: PracticeGenerationOptions,
): Promise<PracticeGenerationRunResult> {
  const { userId, scopeOverride, signal } = options;
  await assertDatabaseAllowed(request.profileId, request.database, scopeOverride);
  const settings = await getSettings();
  const server = getCachedServerInfo(request.profileId);
  const schema = await schemaTextForTables(
    request.profileId,
    request.database,
    request.tables ?? [],
    settings.aiContextChars,
    scopeOverride,
  );
  const tableNames = schema.includedTables;
  const sample = request.includeSampleData
    ? await sampleDataText(request.profileId, request.database, tableNames)
    : '';
  const messages = buildPracticeGenerationMessages({
    server,
    database: request.database,
    tables: tableNames,
    topics: request.topics,
    difficulty: request.difficulty,
    count: request.count,
    schemaText: schema.text,
    sampleDataText: sample,
  });

  let raw: string;
  let sawDelta = false;
  const handleDelta = (text: string): void => {
    sawDelta = true;
    onDelta(text);
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
    } else {
      const result = await complete(provider, apiKey, messages, {
        temperature: provider.temperature,
        maxTokens: provider.maxTokens,
        signal,
      });
      raw = result.text;
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
      if (raw) handleDelta(raw);
    } else {
      throw error;
    }
  }

  let parsed = parseGeneration(raw);
  if (!parsed && raw.trim() && !signal?.aborted) {
    // The repair is a second bill: it is skipped once the request was
    // cancelled, and it does not resend the schema and the SQL.
    try {
      const repair = await complete(
        provider,
        apiKey,
        buildPracticeRepairMessages(messages, raw, 'challenge set'),
        { temperature: 0, maxTokens: provider.maxTokens, signal },
      );
      parsed = parseGeneration(repair.text);
    } catch {
      // Fall through to the error below.
    }
  }
  if (!parsed) {
    throw new AppError(
      'PRACTICE_GENERATION_FAILED',
      'The provider did not return a valid challenge set. Try again or switch models.',
      502,
    );
  }

  const fallbackTopics: PracticeTopic[] = request.topics.length > 0 ? request.topics : ['select'];
  const fallbackDifficulty = request.difficulty === 'mixed' ? 'medium' : request.difficulty;
  const tableSet = new Set(tableNames);
  const questions: PracticeQuestion[] = [];
  const dropped: string[] = [];

  for (const rawQuestion of parsed.questions) {
    if (questions.length >= request.count) break;
    const kind = questionKind(rawQuestion.type);
    // The stored copy is bounded; the checks below still look at the answer
    // the model gave, so a long answer is not mistaken for a missing one.
    const bounded = boundPracticeQuestion({
      title: rawQuestion.title,
      scenario: rawQuestion.scenario,
      brokenSql: rawQuestion.brokenSql,
      referenceSql: rawQuestion.referenceSql,
      expectedResult: rawQuestion.expectedResult,
      hints: rawQuestion.hints,
      hintLadder: rawQuestion.hintLadder,
      topics: rawQuestion.topics,
      // The ladder leak filter runs against the tables the schema actually
      // included: a skeleton that names one of them is a leak of the answer's
      // FROM source. This is a superset of the stored schemaTables, so the
      // public-time filter below never has to drop a stored tier.
      tables: tableNames.length > 0 ? tableNames : rawQuestion.tables,
    });
    const referenceSql = rawQuestion.referenceSql?.trim() || null;
    let execute = Boolean(
      kind.executableCandidate && rawQuestion.execute !== false && referenceSql,
    );
    if (execute && referenceSql) {
      try {
        await validateReferenceSql(
          request.profileId,
          request.database,
          referenceSql,
          scopeOverride,
        );
      } catch (error) {
        dropped.push(`${rawQuestion.title}: ${(error as Error).message}`);
        execute = false;
        if (kind.executableCandidate) continue;
      }
    }
    if (kind.needsBrokenSql && !rawQuestion.brokenSql?.trim()) {
      dropped.push(`${rawQuestion.title}: missing the SQL to review/fix.`);
      continue;
    }
    if (kind.executableCandidate && !referenceSql) {
      dropped.push(`${rawQuestion.title}: missing a reference solution.`);
      continue;
    }

    const topics = normalizeTopics(rawQuestion.topics, fallbackTopics);
    const tables = (rawQuestion.tables ?? [])
      .map((table) => table.trim())
      .filter((table) => tableSet.has(table));
    questions.push({
      id: crypto.randomUUID(),
      type: rawQuestion.type,
      title: bounded.title.trim().slice(0, 180),
      scenario: bounded.scenario.trim(),
      difficulty: normalizeDifficulty(rawQuestion.difficulty, fallbackDifficulty),
      topics,
      schemaTables: tables.length > 0 ? tables : tableNames.slice(0, 6),
      brokenSql: bounded.brokenSql?.trim() || null,
      referenceSql: bounded.referenceSql?.trim() || null,
      expectedResult: bounded.expectedResult?.trim() || null,
      orderMatters: rawQuestion.orderMatters === true,
      hints: bounded.hints
        .map((hint) => hint.trim())
        .filter(Boolean)
        .slice(0, 5),
      hintLadder: bounded.hintLadder,
      estimatedMinutes: Math.max(1, Math.min(120, Math.round(rawQuestion.estimatedMinutes ?? 10))),
      execute: Boolean(execute && referenceSql),
    });
  }

  if (questions.length === 0) {
    throw new AppError(
      'PRACTICE_GENERATION_FAILED',
      `The provider did not produce a valid challenge.${dropped.length ? ` ${dropped[0]}` : ''}`,
      502,
    );
  }

  const set: PracticeSet = {
    id: crypto.randomUUID(),
    userId,
    profileId: request.profileId,
    createdAt: new Date().toISOString(),
    database: request.database,
    providerId: provider.id,
    model: provider.model,
    summary:
      parsed.summary ||
      `${questions.length} ${request.difficulty === 'mixed' ? 'mixed-difficulty' : request.difficulty} SQL challenges on ${request.database}.`,
    questions,
  };
  await savePracticeSet(set);
  return { set, raw };
}

export async function evaluatePractice(input: {
  userId: string;
  profileId: string;
  setId: string;
  questionId: string;
  userSql?: string;
  userAnswer?: string;
  provider?: AiProvider | null;
  apiKey?: string | null;
  includeAi?: boolean;
  /** Narrows a member session to their sandbox databases. */
  scopeOverride?: { allowed: string[] };
  /** Cancels the provider calls, including the repair round trip. */
  signal?: AbortSignal;
}): Promise<PracticeEvaluation> {
  // Account ownership is checked before the profile, question, duplicate lookup,
  // database access, provider call, or reference-answer use.
  const set = await getOwnedPracticeSet(input.setId, input.userId);
  if (set.profileId !== input.profileId) {
    throw new AppError(
      'PRACTICE_SET_FORBIDDEN',
      'This practice set belongs to another connection.',
      403,
    );
  }
  const question = set.questions.find((item) => item.id === input.questionId);
  if (!question) {
    throw new AppError('PRACTICE_QUESTION_NOT_FOUND', 'Practice question not found.', 404);
  }

  const userSql = (input.userSql ?? '').trim();
  const userAnswer = (input.userAnswer ?? '').trim();
  const scopeOverride = input.scopeOverride;

  // Scope is enforced before the duplicate fast path: a cached grade must never
  // turn into a way to use a database the current session can no longer access.
  await assertDatabaseAllowed(input.profileId, set.database, scopeOverride);

  // Resubmitting the same answer must not inflate the attempt history: return the
  // caller's recorded evaluation instead of grading and storing a second copy.
  const previousAttempts = await listPracticeAttemptsForSet(input.profileId, set.id, input.userId);
  const duplicate = previousAttempts.find(
    (attempt) =>
      attempt.questionId === question.id &&
      isSamePracticeSubmission(attempt, { userSql, userAnswer }),
  );
  if (duplicate) {
    return { ...duplicate.evaluation, duplicate: true };
  }

  const server = getCachedServerInfo(input.profileId);
  const settings = await getSettings();
  const schema = await schemaTextForTables(
    input.profileId,
    set.database,
    question.schemaTables,
    settings.aiContextChars,
    scopeOverride,
  );

  const findings: Finding[] = [];
  const issues: string[] = [];
  let executed = false;
  let comparison: PracticeEvaluation['comparison'] = null;
  let userResult: QueryResult | null = null;
  let referenceResult: QueryResult | null = null;
  let explain: PracticeEvaluation['explain'] = null;

  if (question.execute && userSql) {
    const classification = classifySql(userSql);
    if (
      !classification.multiStatement &&
      classification.overall.readOnly &&
      !classification.overall.lockRead &&
      !classification.overall.needsUnlock
    ) {
      try {
        await assertSqlScope(input.profileId, userSql, set.database, scopeOverride);
        userResult = await executePracticeQuery(
          input.profileId,
          set.database,
          userSql,
          scopeOverride,
        );
      } catch (error) {
        issues.push(`Your query could not be executed: ${(error as Error).message}`);
      }
      if (question.referenceSql) {
        try {
          referenceResult = await executePracticeQuery(
            input.profileId,
            set.database,
            question.referenceSql,
            scopeOverride,
          );
        } catch (error) {
          issues.push(`The reference query could not be executed: ${(error as Error).message}`);
        }
      }
      if (userResult && referenceResult) {
        // The comparison runs on the raw values: masking happens per query, so
        // an aliased credential column could mask differently on the two sides
        // and flip the verdict.
        const graded = comparePracticeResults(userResult, referenceResult, question.orderMatters);
        executed = true;
        // The verdict is decided; the samples reach the client, the attempt
        // store and the AI prompt, so their sensitive cells are masked here.
        comparison = maskPracticeComparison(
          graded,
          userResult,
          referenceResult,
          settings.maskSensitiveColumns,
        );
      }
      // Everything that leaves the grader from here on — prompt, response,
      // attempt store — sees masked rows. The raw copies existed only for the
      // comparison above.
      if (userResult) userResult = maskPracticeResult(userResult, settings.maskSensitiveColumns);
      if (referenceResult) {
        referenceResult = maskPracticeResult(referenceResult, settings.maskSensitiveColumns);
      }
    } else {
      issues.push(
        'This challenge is executable, but your answer contains a write, DDL, or locking statement. Practice mode did not execute it.',
      );
    }
  } else if (!question.execute && userSql) {
    issues.push('This is a review/concept challenge, so your SQL was evaluated without execution.');
  }

  if (userSql) {
    try {
      const review = await runStaticReview({
        profileId: input.profileId,
        database: set.database,
        sql: userSql,
        includeSchema: true,
        includeExplain: false,
        scopeOverride,
      });
      findings.push(...review.findings);
    } catch (error) {
      issues.push(`Static review could not run: ${(error as Error).message}`);
    }
  }

  if (executed && userSql) {
    try {
      explain = await runExplain(input.profileId, userSql, set.database, {
        analyze: false,
        scopeOverride,
      });
      findings.push(...explain.insights);
    } catch {
      // EXPLAIN is best-effort.
    }
  }

  let ai: ParsedEvaluation | null = null;
  let aiRepairAttempted = false;
  if (input.includeAi && input.provider) {
    try {
      const messages = buildPracticeEvaluationMessages({
        server,
        database: set.database,
        question,
        userSql,
        userAnswer,
        executed,
        comparison,
        findings,
        explain,
        userResult,
        referenceResult,
        schemaText: schema.text,
      });
      const result = await complete(input.provider, input.apiKey ?? null, messages, {
        temperature: 0.1,
        maxTokens: Math.min(input.provider.maxTokens, 2_048),
        signal: input.signal,
      });
      ai = parseEvaluation(result.text);
      if (!ai && result.text.trim() && !input.signal?.aborted) {
        // The repair is a second bill: it is skipped once the request was
        // cancelled, and it does not resend the schema and the SQL.
        aiRepairAttempted = true;
        const repair = await complete(
          input.provider,
          input.apiKey ?? null,
          buildPracticeRepairMessages(messages, result.text, 'grading result'),
          {
            temperature: 0,
            maxTokens: Math.min(input.provider.maxTokens, 2_048),
            signal: input.signal,
          },
        );
        ai = parseEvaluation(repair.text);
      }
    } catch {
      ai = null;
    }
  }

  const aiScores: Partial<PracticeScores> | null = ai
    ? {
        correctness: ai.correctness,
        performance: ai.performance,
        style: ai.style,
      }
    : null;
  const scores = scorePractice({
    findings,
    comparison,
    executed,
    aiScores,
    submission: {
      userSql,
      userAnswer,
      questionType: question.type,
      referenceSql: question.referenceSql,
    },
  });
  const verdict = practiceVerdict(comparison, executed, scores);

  const deterministicSummary = !executed
    ? 'Your answer was reviewed without execution.'
    : comparison?.matched
      ? 'Your result matches the reference.'
      : comparison
        ? `${comparison.matchedRows} row(s) matched; ${comparison.unmatchedRows} differ.`
        : 'The answer was not executed.';
  const summary = ai?.summary || deterministicSummary;
  const strengths = ai?.strengths.length
    ? ai.strengths
    : comparison?.matched
      ? ['The result matches the reference.']
      : [];
  const combinedIssues = [
    ...issues,
    ...(ai?.issues ?? []),
    ...(comparison && !comparison.matched ? [comparison.reason] : []),
  ];
  const nextHint =
    ai?.nextHint ||
    question.hints[0] ||
    'Compare your result with the reference and check the rows and ordering.';
  const aiFeedback = ai?.feedback ?? null;

  const evaluation: PracticeEvaluation = {
    questionId: question.id,
    executed,
    verdict,
    scores,
    summary,
    strengths,
    issues: Array.from(new Set(combinedIssues)).slice(0, 12),
    nextHint,
    comparison,
    findings,
    explain,
    aiFeedback,
    referenceSql: question.referenceSql,
    userSql: userSql || null,
    userAnswer: userAnswer || null,
    userResult,
    referenceResult,
    aiRepairAttempted: aiRepairAttempted || undefined,
  };

  const attemptedAt = new Date().toISOString();
  await addPracticeAttempt({
    id: crypto.randomUUID(),
    userId: input.userId,
    profileId: input.profileId,
    setId: set.id,
    questionId: question.id,
    database: set.database,
    topics: question.topics,
    difficulty: question.difficulty,
    userSql,
    userAnswer,
    evaluation: {
      ...evaluation,
      userResult: null,
      referenceResult: null,
      explain: null,
    },
    createdAt: attemptedAt,
  });

  // Spaced-repetition scheduling rides on the recorded attempt. The
  // duplicate-submission path above returned before this point, so a duplicate
  // never touches the review queue. Scheduling is best-effort: the attempt is
  // already recorded, so a queue failure must not fail the response.
  try {
    await recordPracticeReviewOutcome({
      userId: input.userId,
      profileId: input.profileId,
      setId: set.id,
      questionId: question.id,
      verdict: evaluation.verdict,
      topics: question.topics,
      difficulty: question.difficulty,
      attemptedAt,
    });
  } catch (error) {
    console.warn(
      `[mylens] Could not update the practice review queue: ${(error as Error).message}`,
    );
  }

  return evaluation;
}

async function executePracticeQuery(
  profileId: string,
  database: string,
  sql: string,
  scopeOverride?: { allowed: string[] },
): Promise<QueryResult> {
  // Rows come back unmasked so the comparison sees the real values on both
  // sides. `evaluatePractice` masks everything it keeps, persists, or returns.
  return executeQuery(profileId, sql, {
    database,
    rowLimit: 200,
    timeoutMs: 10_000,
    skipHistory: true,
    revealSensitive: false,
    skipMasking: true,
    scopeOverride,
  });
}

/**
 * Re-apply the source-aware masking to a result that was executed raw for the
 * comparison. The sensitivity rule is the one `executeQuery` would have
 * applied, so the previews the client sees stay identical.
 */
function maskPracticeResult(result: QueryResult, enabled: boolean): QueryResult {
  const masked = maskResultRows(result.columns, result.rows, {
    enabled,
    reveal: false,
    sql: result.sql,
  });
  return {
    ...result,
    columns: masked.columns,
    rows: masked.rows,
    rowCount: masked.rows.length,
    bytesApprox: estimateBytes(masked.rows),
    masked: masked.masked,
  };
}
