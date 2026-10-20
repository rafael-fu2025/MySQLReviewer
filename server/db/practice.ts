import type {
  Finding,
  PracticeComparison,
  PracticeScores,
  QueryResult,
} from '../../shared/types';
import { AppError } from '../errors';
import { classifySql } from '../review/sql-classifier';
import { scoreFindings } from '../review/scoring';
import { executeQuery } from './query';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
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

export function scorePractice(input: {
  findings: Finding[];
  comparison: PracticeComparison | null;
  executed: boolean;
  aiScores?: Partial<PracticeScores> | null;
}): PracticeScores {
  const scored = scoreFindings(input.findings);
  const performance = clamp(100 - scored.deductions.performance);
  const style = clamp(
    100 - scored.deductions.maintainability - scored.deductions.style,
  );

  let correctness: number;
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
  } else if (input.executed) {
    correctness = 0;
  } else {
    correctness = clamp(input.aiScores?.correctness ?? 0);
  }

  const overall = input.executed
    ? clamp(correctness * 0.6 + performance * 0.25 + style * 0.15)
    : clamp(
        (input.aiScores?.correctness ?? 0) * 0.6 +
          (input.aiScores?.performance ?? performance) * 0.25 +
          (input.aiScores?.style ?? style) * 0.15,
      );

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
