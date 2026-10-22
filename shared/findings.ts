import type { Finding, Severity } from './types';

/**
 * Counts findings by severity.
 *
 * Shared by the server (scoring, reports) and the client (finding filters)
 * so both agree on the zero counts for severities that do not occur.
 */
export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
