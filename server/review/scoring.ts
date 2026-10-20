import type { Finding, FindingCategory, ScoreResult, Severity } from '../../shared/types';
import { severityCounts } from './findings';

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 30,
  high: 12,
  medium: 5,
  low: 1,
  info: 0,
};

const CATEGORY_CAP = 40;

const CATEGORIES: FindingCategory[] = [
  'correctness',
  'performance',
  'security',
  'schema',
  'config',
  'style',
  'maintainability',
];

export function gradeForScore(score: number): ScoreResult['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function scoreFindings(findings: Finding[]): ScoreResult {
  const deductions = Object.fromEntries(
    CATEGORIES.map((category) => [category, 0]),
  ) as Record<FindingCategory, number>;

  for (const finding of findings) {
    deductions[finding.category] =
      (deductions[finding.category] ?? 0) + SEVERITY_WEIGHT[finding.severity];
  }
  for (const category of CATEGORIES) {
    deductions[category] = Math.min(CATEGORY_CAP, deductions[category]);
  }
  const totalDeduction = Object.values(deductions).reduce((sum, value) => sum + value, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - totalDeduction)));
  return {
    score,
    grade: gradeForScore(score),
    counts: severityCounts(findings),
    deductions,
  };
}

export function emptyScore(): ScoreResult {
  return {
    score: 100,
    grade: 'A',
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    deductions: Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
      FindingCategory,
      number
    >,
  };
}
