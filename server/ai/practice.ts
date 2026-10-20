import crypto from 'node:crypto';
import { z } from 'zod';
import type {
  AiProvider,
  Finding,
  PracticeDifficulty,
  PracticeEvaluation,
  PracticeGenerateRequest,
  PracticeQuestion,
  PracticeSet,
  PracticeTopic,
  PracticeScores,
  QueryResult,
  ServerInfo,
} from '../../shared/types';
import { PRACTICE_TOPICS } from '../../shared/types';
import { AppError } from '../errors';
import { getSettings } from '../store/settings';
import { getCachedServerInfo } from '../db/manager';
import { getSchemaSnapshot, getTableData } from '../db/introspection';
import { assertDatabaseAllowed, assertSqlScope } from '../db/scope';
import { schemaToText } from '../review/context';
import { runStaticReview } from '../review/static-review';
import { runExplain } from '../db/explain';
import { classifySql } from '../review/sql-classifier';
import { executeQuery } from '../db/query';
import {
  comparePracticeResults,
  practiceVerdict,
  scorePractice,
  validateReferenceSql,
} from '../db/practice';
import {
  addPracticeAttempt,
  getPracticeSet,
  savePracticeSet,
} from '../store/practice';
import { complete, stream } from './index';
import { extractJsonObject } from './analyze';
import {
  buildPracticeEvaluationMessages,
  buildPracticeGenerationMessages,
} from './practice-prompts';

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
    estimatedMinutes: z.number().optional(),
    execute: z.boolean().optional(),
  })
  .passthrough();

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

function questionKind(
  type: PracticeQuestion['type'],
): { executableCandidate: boolean; needsBrokenSql: boolean } {
  return {
    executableCandidate: type === 'write-query' || type === 'fix-query',
    needsBrokenSql: type === 'fix-query' || type === 'review-query',
  };
}

async function schemaTextForTables(
  profileId: string,
  database: string,
  tables: string[],
  maxChars: number,
): Promise<{ text: string; includedTables: string[] }> {
  const snapshot = await getSchemaSnapshot(profileId, database);
  const selected = tables.length > 0
    ? snapshot.tables.filter((table) => tables.includes(table.name))
    : snapshot.tables
        .slice()
        .sort((a, b) => b.rowsEstimate - a.rowsEstimate)
        .slice(0, 20);
  return {
    text: schemaToText(selected, maxChars),
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
  signal?: AbortSignal,
): Promise<PracticeGenerationRunResult> {
  await assertDatabaseAllowed(request.profileId, request.database);
  const settings = await getSettings();
  const server = getCachedServerInfo(request.profileId);
  const schema = await schemaTextForTables(
    request.profileId,
    request.database,
    request.tables ?? [],
    settings.aiContextChars,
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

  let raw = '';
  let usage = null;
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

  let parsed = parseGeneration(raw);
  if (!parsed && raw.trim()) {
    try {
      const repair = await complete(
        provider,
        apiKey,
        [
          ...messages,
          { role: 'assistant', content: raw.slice(0, 30_000) },
          {
            role: 'user',
            content:
              'Return the same challenge set again as exactly one JSON object matching the requested shape. No markdown fences or prose.',
          },
        ],
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

  const fallbackTopics: PracticeTopic[] =
    request.topics.length > 0 ? request.topics : ['select'];
  const fallbackDifficulty =
    request.difficulty === 'mixed' ? 'medium' : request.difficulty;
  const tableSet = new Set(tableNames);
  const questions: PracticeQuestion[] = [];
  const dropped: string[] = [];

  for (const rawQuestion of parsed.questions) {
    if (questions.length >= request.count) break;
    const kind = questionKind(rawQuestion.type);
    const referenceSql = rawQuestion.referenceSql?.trim() || null;
    let execute = Boolean(kind.executableCandidate && rawQuestion.execute !== false && referenceSql);
    if (execute && referenceSql) {
      try {
        await validateReferenceSql(request.profileId, request.database, referenceSql);
      } catch (error) {
        dropped.push(
          `${rawQuestion.title}: ${(error as Error).message}`,
        );
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
      title: rawQuestion.title.trim().slice(0, 180),
      scenario: rawQuestion.scenario.trim(),
      difficulty: normalizeDifficulty(rawQuestion.difficulty, fallbackDifficulty),
      topics,
      schemaTables: tables.length > 0 ? tables : tableNames.slice(0, 6),
      brokenSql: rawQuestion.brokenSql?.trim() || null,
      referenceSql,
      expectedResult: rawQuestion.expectedResult?.trim() || null,
      orderMatters: rawQuestion.orderMatters === true,
      hints: (rawQuestion.hints ?? []).map((hint) => hint.trim()).filter(Boolean).slice(0, 5),
      estimatedMinutes: Math.max(
        1,
        Math.min(120, Math.round(rawQuestion.estimatedMinutes ?? 10)),
      ),
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
  profileId: string;
  setId: string;
  questionId: string;
  userSql?: string;
  userAnswer?: string;
  provider?: AiProvider | null;
  apiKey?: string | null;
  includeAi?: boolean;
}): Promise<PracticeEvaluation> {
  const set = await getPracticeSet(input.setId);
  if (set.profileId !== input.profileId) {
    throw new AppError('PRACTICE_SET_FORBIDDEN', 'This practice set belongs to another connection.', 403);
  }
  const question = set.questions.find((item) => item.id === input.questionId);
  if (!question) {
    throw new AppError('PRACTICE_QUESTION_NOT_FOUND', 'Practice question not found.', 404);
  }
  await assertDatabaseAllowed(input.profileId, set.database);
  const server = getCachedServerInfo(input.profileId);
  const settings = await getSettings();
  const schema = await schemaTextForTables(
    input.profileId,
    set.database,
    question.schemaTables,
    settings.aiContextChars,
  );

  const userSql = (input.userSql ?? '').trim();
  const userAnswer = (input.userAnswer ?? '').trim();
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
        await assertSqlScope(input.profileId, userSql, set.database);
        userResult = await executePracticeQuery(input.profileId, set.database, userSql);
      } catch (error) {
        issues.push(`Your query could not be executed: ${(error as Error).message}`);
      }
      if (question.referenceSql) {
        try {
          referenceResult = await executePracticeQuery(
            input.profileId,
            set.database,
            question.referenceSql,
          );
        } catch (error) {
          issues.push(`The reference query could not be executed: ${(error as Error).message}`);
        }
      }
      if (userResult && referenceResult) {
        comparison = comparePracticeResults(
          userResult,
          referenceResult,
          question.orderMatters,
        );
        executed = true;
      }
    } else {
      issues.push(
        'This challenge is executable, but your answer contains a write, DDL, or locking statement. Practice mode did not execute it.',
      );
    }
  } else if (!question.execute && userSql) {
    issues.push(
      'This is a review/concept challenge, so your SQL was evaluated without execution.',
    );
  }

  if (userSql) {
    try {
      const review = await runStaticReview({
        profileId: input.profileId,
        database: set.database,
        sql: userSql,
        includeSchema: true,
        includeExplain: false,
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
      });
      findings.push(...explain.insights);
    } catch {
      // EXPLAIN is best-effort.
    }
  }

  let ai: ParsedEvaluation | null = null;
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
      });
      ai = parseEvaluation(result.text);
      if (!ai) {
        const repair = await complete(
          input.provider,
          input.apiKey ?? null,
          [
            ...messages,
            { role: 'assistant', content: result.text.slice(0, 20_000) },
            {
              role: 'user',
              content:
                'Return the grading result again as exactly one JSON object. No markdown fences or prose.',
            },
          ],
          { temperature: 0, maxTokens: Math.min(input.provider.maxTokens, 2_048) },
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
  const scores = scorePractice({ findings, comparison, executed, aiScores });
  const verdict = practiceVerdict(comparison, executed, scores);

  const deterministicSummary = !executed
    ? 'Your answer was reviewed without execution.'
    : comparison?.matched
      ? 'Your result matches the reference.'
      : comparison
        ? `${comparison.matchedRows} row(s) matched; ${comparison.unmatchedRows} differ.`
        : 'The answer was not executed.';
  const summary = ai?.summary || deterministicSummary;
  const strengths =
    ai?.strengths.length
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
  };

  await addPracticeAttempt({
    id: crypto.randomUUID(),
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
    createdAt: new Date().toISOString(),
  });

  return evaluation;
}

async function executePracticeQuery(
  profileId: string,
  database: string,
  sql: string,
): Promise<QueryResult> {
  return executeQuery(profileId, sql, {
    database,
    rowLimit: 200,
    timeoutMs: 10_000,
    skipHistory: true,
    revealSensitive: false,
  });
}
