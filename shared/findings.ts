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
  for (const finding of findings) {
    // A non-canonical severity (an AI provider can answer "CRITICAL") must not
    // create a stray key: `counts['CRITICAL']` is undefined, and `undefined + 1`
    // is NaN, which then shows up as a NaN bucket in the client filters.
    if (Object.prototype.hasOwnProperty.call(counts, finding.severity)) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}
