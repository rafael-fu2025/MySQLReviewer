import { describe, expect, it } from 'vitest';
import type { Finding } from '../shared/types';
import {
  emptyScore,
  gradeForScore,
  scoreFindings,
  SEVERITY_WEIGHT,
} from '../server/review/scoring';

function finding(
  severity: Finding['severity'],
  category: Finding['category'] = 'correctness',
): Finding {
  return {
    id: `${severity}-${category}-${Math.random()}`,
    ruleId: `test.${severity}`,
    title: 'test',
    severity,
    category,
    message: 'test',
    recommendation: 'test',
    source: 'rule',
  };
}

describe('scoring', () => {
  it('returns a perfect score when empty', () => {
    expect(emptyScore()).toMatchObject({ score: 100, grade: 'A' });
  });

  it('deducts per severity', () => {
    const score = scoreFindings([finding('critical')]);
    expect(score.score).toBe(100 - SEVERITY_WEIGHT.critical);
    expect(score.grade).toBe('C');
    expect(score.counts.critical).toBe(1);
  });

  it('caps deductions per category', () => {
    const findings = Array.from({ length: 10 }, () => finding('critical'));
    const score = scoreFindings(findings);
    expect(score.deductions.correctness).toBe(40);
    expect(score.score).toBe(60);
    expect(score.grade).toBe('D');
  });

  it('applies grade thresholds', () => {
    expect(gradeForScore(95)).toBe('A');
    expect(gradeForScore(85)).toBe('B');
    expect(gradeForScore(75)).toBe('C');
    expect(gradeForScore(65)).toBe('D');
    expect(gradeForScore(10)).toBe('F');
  });

  it('ignores info findings', () => {
    const score = scoreFindings([finding('info')]);
    expect(score.score).toBe(100);
  });

  it('never produces NaN for a non-canonical severity (R-15)', () => {
    const malformed = {
      ...finding('info'),
      severity: 'CRITICAL' as unknown as Finding['severity'],
    };
    const score = scoreFindings([malformed]);
    expect(Number.isNaN(score.score)).toBe(false);
    expect(score.grade).toBe('A');
    expect(score.score).toBe(100);
  });
});
