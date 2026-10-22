import type { Finding, FindingCategory, FindingObject, Severity } from '../../../shared/types';
import { createFinding } from '../findings';

/**
 * Static identity of a rule. Everything a finding needs that does not depend
 * on the concrete input lives here, so a rule is declared in exactly one place.
 */
export interface RuleMeta {
  /** Stable identifier, namespaced by module (`sql.*`, `schema.*`, ...). */
  id: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  /** Optional documentation link or note carried onto every finding. */
  docs?: string;
}

/**
 * One finding produced by a rule. Only the fields that can vary per hit are
 * required; everything else falls back to the rule metadata.
 */
export interface RuleHit {
  message: string;
  recommendation: string;
  /** Overrides the rule's default severity for this hit. */
  severity?: Severity;
  /** Overrides the rule's default category for this hit. */
  category?: FindingCategory;
  evidence?: string;
  line?: number | null;
  column?: number | null;
  object?: FindingObject;
  docs?: string;
  confidence?: 'high' | 'medium' | 'low';
}

/** A rule returns nothing, one hit, or many hits. */
export type RuleResult = RuleHit | RuleHit[] | null | undefined | false;

/**
 * A rule is a descriptor plus a check. The check returns the findings it
 * produced, or nothing when the rule does not apply to the input.
 */
export interface Rule<TInput> {
  meta: RuleMeta;
  check(input: TInput): RuleResult;
}

export function defineRule<TInput>(
  meta: RuleMeta,
  check: (input: TInput) => RuleResult,
): Rule<TInput> {
  return { meta, check };
}

/**
 * Runs a rule set and converts hits into findings.
 *
 * Hit order is preserved, so the findings a rule set produces are stable and
 * can be compared against a recorded baseline.
 */
export function runRules<TInput>(rules: readonly Rule<TInput>[], input: TInput): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    const result = rule.check(input);
    if (!result) continue;
    const hits = Array.isArray(result) ? result : [result];
    for (const hit of hits) {
      if (!hit) continue;
      findings.push(
        createFinding({
          ruleId: rule.meta.id,
          title: rule.meta.title,
          severity: hit.severity ?? rule.meta.severity,
          category: hit.category ?? rule.meta.category,
          message: hit.message,
          recommendation: hit.recommendation,
          evidence: hit.evidence,
          line: hit.line ?? null,
          column: hit.column ?? null,
          object: hit.object,
          docs: hit.docs ?? rule.meta.docs,
          source: 'rule',
          confidence: hit.confidence ?? 'high',
        }),
      );
    }
  }
  return findings;
}

/** Describes a rule set for catalogs and documentation. */
export interface RuleCatalogEntry {
  id: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  module: string;
}

export function describeRules<TInput>(
  module: string,
  rules: readonly Rule<TInput>[],
): RuleCatalogEntry[] {
  return rules.map((rule) => ({
    id: rule.meta.id,
    title: rule.meta.title,
    severity: rule.meta.severity,
    category: rule.meta.category,
    module,
  }));
}
