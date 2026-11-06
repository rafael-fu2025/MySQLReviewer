import crypto from 'node:crypto';
import type {
  Finding,
  FindingCategory,
  FindingGroup,
  FindingObject,
  FindingSource,
  Severity,
} from '../../shared/types';
import { SEVERITY_ORDER } from '../../shared/types';
import { severityCounts as countBySeverity } from '../../shared/findings';

/**
 * Counts findings by severity.
 *
 * Severities outside the canonical set are ignored instead of poisoning the
 * counters with `NaN`; every producer normalises the severity before it
 * reaches this point, so this only guards against malformed input.
 */
export function severityCounts(findings: Finding[]): Record<Severity, number> {
  return countBySeverity(findings.filter((finding) => SEVERITY_ORDER.includes(finding.severity)));
}

export interface FindingInput {
  ruleId: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  message: string;
  recommendation: string;
  evidence?: string;
  line?: number | null;
  column?: number | null;
  object?: FindingObject;
  docs?: string;
  source?: FindingSource;
  confidence?: 'high' | 'medium' | 'low';
  /** Index of the statement the finding belongs to; part of the dedupe key. */
  statementIndex?: number;
}

export function createFinding(input: FindingInput): Finding {
  return {
    id: crypto.randomUUID(),
    ruleId: input.ruleId,
    title: input.title,
    severity: input.severity,
    category: input.category,
    message: input.message,
    recommendation: input.recommendation,
    evidence: input.evidence,
    line: input.line ?? null,
    column: input.column ?? null,
    object: input.object,
    docs: input.docs,
    source: input.source ?? 'rule',
    confidence: input.confidence ?? 'high',
    statementIndex: input.statementIndex,
  };
}

function objectKey(object?: FindingObject): string {
  if (!object) return '';
  return [
    object.database ?? '',
    object.table ?? '',
    object.column ?? '',
    object.index ?? '',
    object.user ?? '',
    object.host ?? '',
  ].join('/');
}

export function findingKey(finding: Finding): string {
  // The statement index keeps two statements that share a line apart. Without
  // it, e.g. `UPDATE a ...; UPDATE b ...;` on one line produces the same key
  // twice and one of the findings is discarded.
  return `${finding.ruleId}|${finding.statementIndex ?? ''}|${finding.line ?? ''}|${objectKey(finding.object)}`;
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const map = new Map<string, Finding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, finding);
      continue;
    }
    const existingRank = SEVERITY_ORDER.indexOf(existing.severity);
    const nextRank = SEVERITY_ORDER.indexOf(finding.severity);
    if (nextRank < existingRank) map.set(key, finding);
  }
  return Array.from(map.values()).sort((a, b) => {
    const severities = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severities !== 0) return severities;
    return a.ruleId.localeCompare(b.ruleId);
  });
}

export function groupFindings(findings: Finding[], maxInstances = 25): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    let group = groups.get(finding.ruleId);
    if (!group) {
      group = {
        ruleId: finding.ruleId,
        title: finding.title,
        severity: finding.severity,
        category: finding.category,
        count: 0,
        instances: [],
        docs: finding.docs,
      };
      groups.set(finding.ruleId, group);
    }
    group.count += 1;
    if (group.instances.length < maxInstances) group.instances.push(finding);
    if (SEVERITY_ORDER.indexOf(finding.severity) < SEVERITY_ORDER.indexOf(group.severity)) {
      group.severity = finding.severity;
    }
  }
  return Array.from(groups.values()).sort((a, b) => {
    const severities = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severities !== 0) return severities;
    if (a.count !== b.count) return b.count - a.count;
    return a.title.localeCompare(b.title);
  });
}
