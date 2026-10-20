import { describe, expect, it } from 'vitest';
import type { QueryColumn, QueryResult } from '../shared/types';
import {
  comparePracticeResults,
  practiceVerdict,
  scorePractice,
} from '../server/db/practice';

function columns(count: number): QueryColumn[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `c${index}`,
    originalName: `c${index}`,
    table: 't',
    database: 'shop',
    typeName: 'INT',
    typeCode: 3,
    flags: 0,
  }));
}

function result(rows: unknown[][], columnCount = 2, truncated = false): QueryResult {
  return {
    sql: 'SELECT 1',
    database: 'shop',
    kind: 'read',
    columns: columns(columnCount),
    rows: rows as never,
    rowCount: rows.length,
    truncated,
    affectedRows: 0,
    insertId: null,
    info: '',
    warnings: [],
    executionMs: 1,
    bytesApprox: 1,
    unlocked: false,
    masked: false,
  };
}

describe('practice result comparison', () => {
  it('matches unordered rows', () => {
    const comparison = comparePracticeResults(
      result([[1, 'a'], [2, 'b']]),
      result([[2, 'b'], [1, 'a']]),
      false,
    );
    expect(comparison.matched).toBe(true);
    expect(comparison.matchedRows).toBe(2);
  });

  it('enforces ordering when requested', () => {
    const comparison = comparePracticeResults(
      result([[1, 'a'], [2, 'b']]),
      result([[2, 'b'], [1, 'a']]),
      true,
    );
    expect(comparison.matched).toBe(false);
    expect(comparison.reason).toContain('order');
  });

  it('reports extra and missing rows', () => {
    const comparison = comparePracticeResults(
      result([[1, 'a'], [2, 'b'], [3, 'c']]),
      result([[1, 'a'], [2, 'b']]),
      false,
    );
    expect(comparison.matched).toBe(false);
    expect(comparison.extraRows).toHaveLength(1);
    expect(comparison.missingRows).toHaveLength(0);
  });

  it('detects column-count differences', () => {
    const comparison = comparePracticeResults(
      result([[1, 'a']], 2),
      result([[1]], 1),
      false,
    );
    expect(comparison.matched).toBe(false);
    expect(comparison.reason).toContain('column');
  });

  it('marks truncated matches', () => {
    const comparison = comparePracticeResults(
      result([[1, 'a']], 2, true),
      result([[1, 'a']], 2),
      false,
    );
    expect(comparison.matched).toBe(true);
    expect(comparison.truncated).toBe(true);
    const scores = scorePractice({
      findings: [],
      comparison,
      executed: true,
    });
    expect(scores.correctness).toBe(90);
    expect(scores.overall).toBe(94);
  });
});

describe('practice scoring', () => {
  it('gives full credit for a matching result', () => {
    const comparison = comparePracticeResults(
      result([[1, 'a']]),
      result([[1, 'a']]),
      false,
    );
    const scores = scorePractice({ findings: [], comparison, executed: true });
    expect(scores.correctness).toBe(100);
    expect(scores.performance).toBe(100);
    expect(scores.style).toBe(100);
    expect(scores.overall).toBe(100);
    expect(practiceVerdict(comparison, true, scores)).toBe('correct');
  });

  it('uses AI scores for non-executed answers', () => {
    const scores = scorePractice({
      findings: [],
      comparison: null,
      executed: false,
      aiScores: { correctness: 80, performance: 90, style: 90 },
    });
    expect(scores.overall).toBe(84);
  });
});
