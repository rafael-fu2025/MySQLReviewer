import type {
  CellValue,
  Finding,
  PracticeAnswers,
  PracticeAttempt,
  PracticeAttemptPublic,
  PracticeComparison,
  PracticeEvaluation,
  PracticeEvaluationPublic,
  PracticeHintLadder,
  PracticeProgress,
  PracticeProgressPublic,
  PracticeQuestion,
  PracticeQuestionPublic,
  PracticeReviewQueueItem,
  PracticeScores,
  PracticeSet,
  PracticeSetPublic,
  PracticeTaskType,
  QueryResult,
} from '../../shared/types';
import { AppError } from '../errors';
import { classifySql } from '../review/sql-classifier';
import { scoreFindings } from '../review/scoring';
import { maskCell } from './masking';
import { executeQuery } from './query';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/* ------------------------------------------------------------------ */
/* Client-safe payloads                                                */
/* ------------------------------------------------------------------ */

/**
 * Words that mark a `SELECT … FROM` fragment as English guidance rather than a
 * statement. The list only has to separate "select the columns from two
 * tables" (guidance) from "SELECT c.id FROM customers" (the answer), so it is
 * small on purpose: SQL keywords, CASE arms and function names (`when`,
 * `then`, `if`, `count`, `where`) stay out so that real SQL is still flagged.
 */
const PROSE_WORDS = new Set([
  'the',
  'an',
  'your',
  'their',
  'its',
  'our',
  'my',
  'his',
  'her',
  'this',
  'that',
  'these',
  'those',
  'it',
  'them',
  'they',
  'all',
  'any',
  'each',
  'every',
  'some',
  'both',
  'either',
  'neither',
  'one',
  'two',
  'three',
  'first',
  'second',
  'third',
  'other',
  'another',
  'only',
  'same',
  'of',
  'by',
  'per',
  'and',
  'or',
  'which',
  'what',
  'who',
  'how',
  'why',
  'matching',
  'missing',
  'extra',
  'duplicate',
  'specific',
  'certain',
  'relevant',
  'desired',
  'needed',
  'row',
  'rows',
  'column',
  'columns',
  'field',
  'fields',
  'record',
  'records',
]);

/** The projection and the source of a `SELECT … FROM` fragment. */
const SELECT_FROM_SHAPE = /\bselect\b\s+([\s\S]{0,300}?)\s+\bfrom\b\s+[`'"[]?\s*([\w$]+)/i;

/** Keyword pairs that only statements have; prose says "update the clause". */
const WRITE_SHAPE = /\b(?:insert\s+into|update\s+[\w$`]+\s+set|delete\s+from)\s+[\w$`]+/i;

/** A fenced block is treated as the answer only when it holds a statement. */
const FENCED_SQL =
  /```[\s\S]*?\b(?:select|insert|update|delete|with|create|alter|drop|truncate)\b/i;

/** Prose rarely terminates a clause, so `SELECT … FROM … ;` is a statement. */
const TERMINATED_SHAPE = /\bselect\b[\s\S]{0,400}?\bfrom\b[\s\S]{0,200}?;/;

/**
 * Hints are free-form model output. A hint that *is* the answer — a statement
 * wearing a hint costume — is dropped from the public payload.
 *
 * The heuristic is conservative in both directions: it must still catch real
 * leaks, but guidance that merely uses the words select/from must survive. A
 * hint is treated as answer-revealing when it
 *   - holds a fenced block containing a statement keyword,
 *   - holds a `SELECT <projection> FROM <source>` shape whose projection
 *     contains no prose word and whose source is not an English word — or the
 *     source names one of the question's schema tables, because the table list
 *     of the answer is exactly what a hint must not give away,
 *   - holds an `INSERT INTO` / `UPDATE … SET` / `DELETE FROM` shape, or
 *   - terminates a `SELECT … FROM` fragment with `;`.
 *
 * Residual false positives are accepted ("select customers from Germany" still
 * looks like SQL); naming a table outside a FROM source ("join customers to
 * orders …") is guidance and never flags a hint on its own.
 */
export function hintRevealsAnswer(hint: string, schemaTables: readonly string[] = []): boolean {
  if (FENCED_SQL.test(hint)) return true;

  const shape = SELECT_FROM_SHAPE.exec(hint);
  if (shape) {
    const source = shape[2].toLowerCase();
    const projectionWords = shape[1].split(/[^A-Za-z0-9_$*]+/).filter((word) => word.length > 0);
    const readsLikeProse = projectionWords.some((word) => PROSE_WORDS.has(word.toLowerCase()));
    if (!readsLikeProse && !PROSE_WORDS.has(source)) return true;
    if (schemaTables.some((table) => table.toLowerCase() === source)) return true;
  }

  if (WRITE_SHAPE.test(hint)) return true;
  if (TERMINATED_SHAPE.test(hint)) return true;
  return false;
}

/**
 * Runs the leak filter over each hint-ladder tier and drops the tiers that read
 * like the answer. The skeleton tier legitimately holds SQL-ish fragments, so
 * it gets the same filter as-is: when it trips, only that tier is dropped and
 * the word tiers survive. Returns undefined when no tier survives.
 */
export function filterPracticeHintLadder(
  ladder: PracticeHintLadder,
  schemaTables: readonly string[],
): PracticeHintLadder | undefined {
  const filtered: PracticeHintLadder = {};
  for (const tier of ['nudge', 'approach', 'skeleton'] as const) {
    const value = ladder[tier]?.trim();
    if (!value) continue;
    if (hintRevealsAnswer(value, schemaTables)) continue;
    filtered[tier] = value;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function toPublicPracticeQuestion(question: PracticeQuestion): PracticeQuestionPublic {
  const base: PracticeQuestionPublic = {
    id: question.id,
    type: question.type,
    title: question.title,
    scenario: question.scenario,
    difficulty: question.difficulty,
    topics: question.topics,
    schemaTables: question.schemaTables,
    orderMatters: question.orderMatters,
    hints: question.hints.filter((hint) => !hintRevealsAnswer(hint, question.schemaTables)),
    estimatedMinutes: question.estimatedMinutes,
    execute: question.execute,
  };
  // Same per-tier leak filter as the flat hints: a ladder tier that is the
  // answer wearing a hint costume never reaches the client.
  const hintLadder = question.hintLadder
    ? filterPracticeHintLadder(question.hintLadder, question.schemaTables)
    : undefined;
  if (hintLadder) base.hintLadder = hintLadder;
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
  const { referenceSql: _referenceSql, referenceResult: _referenceResult, ...safe } = evaluation;
  return safe;
}

export function toPublicPracticeAttempt(attempt: PracticeAttempt): PracticeAttemptPublic {
  return {
    ...attempt,
    evaluation: toPublicPracticeEvaluation(attempt.evaluation),
  };
}

export function toPublicPracticeProgress(progress: PracticeProgress): PracticeProgressPublic {
  return {
    ...progress,
    recent: progress.recent.map(toPublicPracticeAttempt),
  };
}

/** The queue data a review card needs, resolved to its question text. */
export interface PracticeReviewSource {
  item: {
    setId: string;
    questionId: string;
    box: number;
    dueAt: string;
    lastVerdict: PracticeReviewQueueItem['lastVerdict'];
    lastAttemptAt: string;
    topics: PracticeReviewQueueItem['topics'];
    difficulty: PracticeReviewQueueItem['difficulty'];
  };
  title: string;
  scenario: string;
}

/**
 * A due review card for `GET /api/practice/review`. Built field by field from
 * the queue item and the question text only — the reference answer material
 * (`referenceSql`, `expectedResult`, `brokenSql`) is structurally absent, the
 * same gate an unattempted question gets everywhere else.
 */
export function toPublicPracticeReviewItem(
  resolved: PracticeReviewSource,
): PracticeReviewQueueItem {
  return {
    setId: resolved.item.setId,
    questionId: resolved.item.questionId,
    title: resolved.title,
    scenario: resolved.scenario,
    topics: resolved.item.topics,
    difficulty: resolved.item.difficulty,
    box: resolved.item.box,
    dueAt: resolved.item.dueAt,
    lastVerdict: resolved.item.lastVerdict,
    lastAttemptAt: resolved.item.lastAttemptAt,
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

/** A plain numeric string: optional sign, digits, optional fraction and exponent. */
const PLAIN_NUMBER_SHAPE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Exponent bounds for normalization. Real result values never exceed this
 * (DECIMAL holds 65 digits, a DOUBLE prints at most ~3 exponent digits), so a
 * larger exponent is treated as an opaque string instead of allocating the
 * padding it asks for.
 */
const MAX_NORMALIZED_EXPONENT = 4096;

/**
 * Normalize a plain numeric string into one canonical decimal form so that
 * `12.30`, `12.3` and `+12.300` compare equal.
 *
 * The mysql2 pool is configured with `bigNumberStrings` and
 * `decimalNumbers: false` (see `manager.ts`), so DECIMAL aggregates arrive as
 * strings and a formatting difference would otherwise grade a correct answer
 * as wrong. The work stays on the string — no float is ever constructed — so
 * a 30-digit DECIMAL keeps every digit, and exponent forms (`1e3` from a
 * DOUBLE) are folded into plain decimals the same way. Returns null for
 * anything that is not a plain number; those cells keep their exact
 * comparison.
 */
function normalizedDecimalString(value: string): string | null {
  if (!PLAIN_NUMBER_SHAPE.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [mantissa, exponentText] = unsigned.split(/[eE]/);
  const exponent = exponentText !== undefined ? Number(exponentText) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_NORMALIZED_EXPONENT) {
    return null;
  }
  const point = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const shifted = (point === -1 ? mantissa.length : point) + exponent;
  let integerPart: string;
  let fractionPart: string;
  if (shifted <= 0) {
    integerPart = '0';
    fractionPart = '0'.repeat(-shifted) + digits;
  } else if (shifted >= digits.length) {
    integerPart = digits + '0'.repeat(shifted - digits.length);
    fractionPart = '';
  } else {
    integerPart = digits.slice(0, shifted);
    fractionPart = digits.slice(shifted);
  }
  // `007` reads `7`; at least one digit always survives the strip.
  integerPart = integerPart.replace(/^0+(?=\d)/, '');
  fractionPart = fractionPart.replace(/0+$/, '');
  if (integerPart === '0' && fractionPart === '') return '0'; // `-0` compares as `0`
  return `${negative ? '-' : ''}${integerPart}${fractionPart ? `.${fractionPart}` : ''}`;
}

function canonicalCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') {
    const text = value.trim();
    return normalizedDecimalString(text) ?? text;
  }
  if (typeof value === 'number') {
    const text = String(value);
    return normalizedDecimalString(text) ?? text;
  }
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

/**
 * The comparison as the grader produces it. On top of the wire shape it
 * records whether the REFERENCE result was cut at the comparison row cap: a
 * cap-sized reference makes the question a "large" one, which is a property of
 * the question and not of the learner's answer, so `scorePractice` must not
 * charge the truncation penalty for it. `shared/types` keeps the client shape
 * without the flag.
 */
export interface GradedPracticeComparison extends PracticeComparison {
  /** The reference result hit the comparison row cap. */
  referenceTruncated?: boolean;
}

export function comparePracticeResults(
  user: QueryResult,
  reference: QueryResult,
  orderMatters: boolean,
): GradedPracticeComparison {
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
    referenceTruncated: reference.truncated,
  };
}

function sensitiveColumns(result: QueryResult): boolean[] {
  return result.columns.map((column) => column.sensitive === true);
}

/** Mask the sampled cells whose source column is sensitive on that side. */
function maskSampleRow(row: unknown[], sensitive: boolean[]): unknown[] {
  return row.map((cell, index) => {
    if (!sensitive[index]) return cell;
    if (cell === null || cell === undefined || cell === '') return cell;
    return maskCell(cell as CellValue);
  });
}

/**
 * Mask the row samples of a comparison that was computed on raw values.
 *
 * The verdict is decided on unmasked rows (`executePracticeQuery` runs with
 * masking skipped, so an aliased credential column cannot mask differently on
 * the two sides and flip the verdict), but the samples travel to the client,
 * the attempt store and the AI prompt, so their sensitive cells are masked
 * here with the same marker `executeQuery` uses.
 *
 * Each side keeps its own sensitivity: the number of masked columns may differ
 * between the user and reference results, and that asymmetry only affects the
 * samples — the verdict itself was already computed on the raw rows, so a
 * masking difference can never turn a genuine shape difference into a match.
 */
export function maskPracticeComparison<T extends PracticeComparison>(
  comparison: T,
  user: QueryResult,
  reference: QueryResult,
  enabled: boolean,
): T {
  if (!enabled) return comparison;
  return {
    ...comparison,
    missingRows: comparison.missingRows.map((row) =>
      maskSampleRow(row, sensitiveColumns(reference)),
    ),
    extraRows: comparison.extraRows.map((row) => maskSampleRow(row, sensitiveColumns(user))),
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
    const pattern = new RegExp(`(?:^|[^a-z0-9_])${keyword.replace(/ /g, '\\s+')}(?:[^a-z0-9_]|$)`);
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
  comparison: GradedPracticeComparison | null;
  executed: boolean;
  aiScores?: Partial<PracticeScores> | null;
  submission?: PracticeSubmissionSignals | null;
}): PracticeScores {
  const scored = scoreFindings(input.findings);
  const performance = clamp(100 - scored.deductions.performance);
  const style = clamp(100 - scored.deductions.maintainability - scored.deductions.style);

  let correctness: number;
  let overall: number;

  if (input.executed && input.comparison) {
    if (input.comparison.matched) {
      // Truncation costs points only when the learner's own result was cut:
      // when the reference hit the cap the question simply has more rows than
      // the cap, and the compared sample matched.
      correctness = input.comparison.truncated && !input.comparison.referenceTruncated ? 90 : 100;
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
    const structural = input.submission ? staticPracticeCorrectness(input.submission) : 0;
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
  scopeOverride?: { allowed: string[] },
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
    scopeOverride,
  });
}
