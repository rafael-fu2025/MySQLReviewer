import type {
  Finding,
  PracticeAnswers,
  PracticeAttempt,
  PracticeAttemptPublic,
  PracticeComparison,
  PracticeEvaluation,
  PracticeEvaluationPublic,
  PracticeProgress,
  PracticeProgressPublic,
  PracticeQuestion,
  PracticeQuestionPublic,
  PracticeScores,
  PracticeSet,
  PracticeSetPublic,
  PracticeTaskType,
  QueryResult,
} from '../../shared/types';
import { AppError } from '../errors';
import { classifySql } from '../review/sql-classifier';
import { scoreFindings } from '../review/scoring';
import { executeQuery } from './query';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/* ------------------------------------------------------------------ */
/* Client-safe payloads                                                */
/* ------------------------------------------------------------------ */

const SQL_SHAPED_HINT = /\bselect\b[\s\S]{0,400}?\bfrom\b|```/i;

/**
 * Hints are free-form model output. A hint that contains a complete statement is
 * the answer wearing a hint costume, so it is dropped from the public payload.
 */
function hintRevealsAnswer(hint: string): boolean {
  return SQL_SHAPED_HINT.test(hint);
}

export function toPublicPracticeQuestion(
  question: PracticeQuestion,
): PracticeQuestionPublic {
  const base: PracticeQuestionPublic = {
    id: question.id,
    type: question.type,
    title: question.title,
    scenario: question.scenario,
    difficulty: question.difficulty,
    topics: question.topics,
    schemaTables: question.schemaTables,
    orderMatters: question.orderMatters,
    hints: question.hints.filter((hint) => !hintRevealsAnswer(hint)),
    estimatedMinutes: question.estimatedMinutes,
    execute: question.execute,
  };
  // For fix-query tasks the broken statement is the question, so it must be
  // visible before the profile attempts it. Every other type keeps it hidden.
  if (question.type === 'fix-query') {
    return { ...base, brokenSql: question.brokenSql };
  }
  return base;
}

export function toPublicPracticeSet(set: PracticeSet): PracticeSetPublic {
  return {
    ...set,
    questions: set.questions.map(toPublicPracticeQuestion),
  };
}

export function toPublicPracticeEvaluation(
  evaluation: PracticeEvaluation,
): PracticeEvaluationPublic {
  const {
    referenceSql: _referenceSql,
    referenceResult: _referenceResult,
    ...safe
  } = evaluation;
  return safe;
}

export function toPublicPracticeAttempt(attempt: PracticeAttempt): PracticeAttemptPublic {
  return {
    ...attempt,
    evaluation: toPublicPracticeEvaluation(attempt.evaluation),
  };
}

export function toPublicPracticeProgress(
  progress: PracticeProgress,
): PracticeProgressPublic {
  return {
    ...progress,
    recent: progress.recent.map(toPublicPracticeAttempt),
  };
}

/**
 * Answer material is released only to the profile that owns the set. Anything
 * else is a 403 (foreign profile) or, for an unknown set, a 404 from the store.
 */
export function canRevealPracticeAnswers(
  set: Pick<PracticeSet, 'profileId'>,
  profileId: string,
): boolean {
  return set.profileId === profileId;
}

/**
 * Answer material is released only for questions the profile already attempted.
 * The caller is responsible for having verified set ownership.
 */
export function buildPracticeAnswers(
  set: PracticeSet,
  attemptedQuestionIds: ReadonlySet<string>,
): PracticeAnswers {
  return {
    setId: set.id,
    answers: set.questions
      .filter((question) => attemptedQuestionIds.has(question.id))
      .map((question) => ({
        questionId: question.id,
        referenceSql: question.referenceSql,
        expectedResult: question.expectedResult,
        brokenSql: question.brokenSql,
        orderMatters: question.orderMatters,
      })),
  };
}

function canonicalCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    if ('__type' in value && (value as { __type?: string }).__type === 'binary') {
      return `BINARY:${(value as { length?: number }).length ?? 0}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function rowKey(row: unknown[]): string {
  return row.map(canonicalCell).join('\u0001');
}

function sameRows(a: unknown[][], b: unknown[][]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const row of a) {
    const key = rowKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of b) {
    const key = rowKey(row);
    const count = counts.get(key);
    if (!count) return false;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
  }
  return counts.size === 0;
}

export function comparePracticeResults(
  user: QueryResult,
  reference: QueryResult,
  orderMatters: boolean,
): PracticeComparison {
  const userRows = user.rows as unknown[][];
  const referenceRows = reference.rows as unknown[][];
  const columnCountUser = user.columns.length;
  const columnCountReference = reference.columns.length;
  const missing: unknown[][] = [];
  const extra: unknown[][] = [];
  let matchedRows = 0;

  if (orderMatters) {
    const length = Math.max(userRows.length, referenceRows.length);
    for (let i = 0; i < length; i += 1) {
      const userRow = userRows[i];
      const referenceRow = referenceRows[i];
      if (!userRow) {
        if (referenceRow) missing.push(referenceRow);
        continue;
      }
      if (!referenceRow) {
        extra.push(userRow);
        continue;
      }
      if (rowKey(userRow) === rowKey(referenceRow)) matchedRows += 1;
      else {
        missing.push(referenceRow);
        extra.push(userRow);
      }
    }
  } else {
    const referenceCounts = new Map<string, { count: number; row: unknown[] }>();
    for (const row of referenceRows) {
      const key = rowKey(row);
      const current = referenceCounts.get(key);
      if (current) current.count += 1;
      else referenceCounts.set(key, { count: 1, row });
    }
    for (const row of userRows) {
      const key = rowKey(row);
      const current = referenceCounts.get(key);
      if (current && current.count > 0) {
        current.count -= 1;
        matchedRows += 1;
      } else {
        extra.push(row);
      }
    }
    for (const value of referenceCounts.values()) {
      if (value.count > 0) missing.push(value.row);
    }
  }

  const truncated = user.truncated || reference.truncated;
  const matched =
    matchedRows === userRows.length &&
    matchedRows === referenceRows.length &&
    missing.length === 0 &&
    extra.length === 0 &&
    columnCountUser === columnCountReference &&
    userRows.length === referenceRows.length;

  let reason = 'Results match.';
  if (columnCountUser !== columnCountReference) {
    reason = `The reference returns ${columnCountReference} column(s); your answer returns ${columnCountUser}.`;
  } else if (orderMatters && !matched && sameRows(userRows, referenceRows)) {
    reason = 'The rows match as a set, but the required order is different.';
  } else if (!matched) {
    reason = `${extra.length} extra row(s) and ${missing.length} missing row(s) in the compared sample.`;
  } else if (truncated) {
    reason = 'Results match within the compared row cap; one or both results were truncated.';
  }

  return {
    matched,
    reason,
    ordered: orderMatters,
    userRowCount: userRows.length,
    referenceRowCount: referenceRows.length,
    columnCountUser,
    columnCountReference,
    missingRows: missing.slice(0, 20),
    extraRows: extra.slice(0, 20),
    matchedRows,
    unmatchedRows: Math.max(0, Math.max(userRows.length, referenceRows.length) - matchedRows),
    truncated,
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic (AI-free) scoring signals                             */
/* ------------------------------------------------------------------ */

const STRUCTURAL_KEYWORDS = [
  'select',
  'from',
  'join',
  'left join',
  'right join',
  'inner join',
  'cross join',
  'where',
  'group by',
  'having',
  'order by',
  'limit',
  'offset',
  'distinct',
  'union',
  'union all',
  'intersect',
  'except',
  'with',
  'recursive',
  'over',
  'partition by',
  'case',
  'insert',
  'update',
  'delete',
  'exists',
  'between',
  'like',
  'coalesce',
  'count',
  'sum',
  'avg',
  'min',
  'max',
];

function normalizeSqlText(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/#[^\n\r]*/g, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Comparison form used to detect resubmissions of the same answer. */
export function normalizePracticeSql(sql: string): string {
  return normalizeSqlText(sql).replace(/[;\s]+$/, '');
}

export function normalizePracticeAnswer(answer: string): string {
  return answer.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isSamePracticeSubmission(
  a: { userSql?: string | null; userAnswer?: string | null },
  b: { userSql?: string | null; userAnswer?: string | null },
): boolean {
  return (
    normalizePracticeSql(a.userSql ?? '') === normalizePracticeSql(b.userSql ?? '') &&
    normalizePracticeAnswer(a.userAnswer ?? '') === normalizePracticeAnswer(b.userAnswer ?? '')
  );
}

function keywordsIn(sql: string): Set<string> {
  const text = normalizeSqlText(sql);
  const found = new Set<string>();
  for (const keyword of STRUCTURAL_KEYWORDS) {
    const pattern = new RegExp(
      `(?:^|[^a-z0-9_])${keyword.replace(/ /g, '\\s+')}(?:[^a-z0-9_]|$)`,
    );
    if (pattern.test(text)) found.add(keyword);
  }
  return found;
}

function tableReferences(sql: string): Set<string> {
  const text = normalizeSqlText(sql);
  const tables = new Set<string>();
  const pattern = /(?:from|join)\s+([a-z0-9_$.]+)/g;
  let match = pattern.exec(text);
  while (match) {
    const name = match[1].split('.').pop();
    if (name) tables.add(name);
    match = pattern.exec(text);
  }
  return tables;
}

function coverage(required: Set<string>, actual: Set<string>): number {
  if (required.size === 0) return 1;
  let matched = 0;
  for (const value of required) {
    if (actual.has(value)) matched += 1;
  }
  return matched / required.size;
}

export interface PracticeSubmissionSignals {
  userSql: string;
  userAnswer: string;
  questionType: PracticeTaskType;
  referenceSql: string | null;
}

/**
 * Grades an unexecuted submission from structure alone: does the SQL parse, does
 * it cover the clauses and tables the reference needs, and did the profile say
 * anything at all. This replaces the previous "no AI score means zero" rule that
 * capped every non-executed answer at 40 overall.
 */
export function staticPracticeCorrectness(input: PracticeSubmissionSignals): number {
  const sql = input.userSql.trim();
  const answer = input.userAnswer.trim();
  const sqlRequired = input.questionType !== 'concept';

  if (!sql) {
    if (sqlRequired) return answer ? 25 : 0;
    if (!answer) return 0;
    return clamp(40 + Math.min(60, answer.split(/\s+/).length * 2));
  }

  const classified = classifySql(sql);
  if (classified.empty) return 0;

  let score = 60;
  if (input.referenceSql) {
    const keywordScore = coverage(keywordsIn(input.referenceSql), keywordsIn(sql));
    const tableScore = coverage(tableReferences(input.referenceSql), tableReferences(sql));
    score = Math.round((keywordScore * 0.6 + tableScore * 0.4) * 100);
  }
  if (classified.multiStatement) score -= 20;
  if (
    !classified.overall.readOnly ||
    classified.overall.lockRead ||
    classified.overall.needsUnlock
  ) {
    score = Math.min(score, 45);
  }
  return clamp(score);
}

export function scorePractice(input: {
  findings: Finding[];
  comparison: PracticeComparison | null;
  executed: boolean;
  aiScores?: Partial<PracticeScores> | null;
  submission?: PracticeSubmissionSignals | null;
}): PracticeScores {
  const scored = scoreFindings(input.findings);
  const performance = clamp(100 - scored.deductions.performance);
  const style = clamp(
    100 - scored.deductions.maintainability - scored.deductions.style,
  );

  let correctness: number;
  let overall: number;

  if (input.executed && input.comparison) {
    if (input.comparison.matched) {
      correctness = input.comparison.truncated ? 90 : 100;
    } else {
      const denominator = Math.max(
        1,
        input.comparison.userRowCount ?? 0,
        input.comparison.referenceRowCount ?? 0,
      );
      correctness = clamp((input.comparison.matchedRows / denominator) * 70);
      if (input.comparison.columnCountUser !== input.comparison.columnCountReference) {
        correctness = Math.min(correctness, 30);
      }
    }
    overall = clamp(correctness * 0.6 + performance * 0.25 + style * 0.15);
  } else if (input.executed) {
    correctness = 0;
    overall = clamp(performance * 0.25 + style * 0.15);
  } else if (input.aiScores) {
    // AI grading keeps its original weighting.
    correctness = clamp(input.aiScores.correctness ?? 0);
    overall = clamp(
      (input.aiScores.correctness ?? 0) * 0.6 +
        (input.aiScores.performance ?? performance) * 0.25 +
        (input.aiScores.style ?? style) * 0.15,
    );
  } else {
    const structural = input.submission
      ? staticPracticeCorrectness(input.submission)
      : 0;
    correctness = clamp(structural - scored.deductions.correctness);
    overall = clamp(correctness * 0.6 + performance * 0.25 + style * 0.15);
  }

  return { correctness, performance, style, overall };
}

export function practiceVerdict(
  comparison: PracticeComparison | null,
  executed: boolean,
  scores: PracticeScores,
): 'correct' | 'close' | 'incorrect' | 'not-executed' {
  if (!executed) return 'not-executed';
  if (comparison?.matched) return 'correct';
  if (scores.correctness >= 50) return 'close';
  return 'incorrect';
}

export async function validateReferenceSql(
  profileId: string,
  database: string,
  sql: string,
): Promise<QueryResult> {
  const classified = classifySql(sql);
  if (classified.empty) {
    throw new AppError('PRACTICE_INVALID_REFERENCE', 'The reference SQL is empty.', 400);
  }
  if (classified.multiStatement) {
    throw new AppError(
      'PRACTICE_INVALID_REFERENCE',
      'Executable practice references must contain one statement.',
      400,
    );
  }
  const classification = classified.overall;
  if (!classification.readOnly || classification.lockRead || classification.needsUnlock) {
    throw new AppError(
      'PRACTICE_INVALID_REFERENCE',
      'Executable practice references must be read-only SELECT statements.',
      400,
    );
  }
  return executeQuery(profileId, sql, {
    database,
    rowLimit: 100,
    timeoutMs: 5_000,
    skipHistory: true,
    revealSensitive: false,
  });
}
