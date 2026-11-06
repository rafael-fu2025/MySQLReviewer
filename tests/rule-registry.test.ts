import { describe, expect, it } from 'vitest';
import {
  CONFIG_RULES,
  PERFORMANCE_RULES,
  QUERY_SCHEMA_RULES,
  RULE_CATALOG,
  RULES_BY_ID,
  SCHEMA_RULES,
  SECURITY_DEFINER_RULES,
  SECURITY_USER_RULES,
  UNUSED_INDEX_RULE,
} from '../server/review/rules';
import {
  SQL_SCRIPT_HEAD_RULES,
  SQL_SCRIPT_TAIL_RULES,
  SQL_STATEMENT_RULES,
} from '../server/review/rules/sql-rules';

const RULE_SETS = [
  SQL_STATEMENT_RULES,
  SQL_SCRIPT_HEAD_RULES,
  SQL_SCRIPT_TAIL_RULES,
  QUERY_SCHEMA_RULES,
  SCHEMA_RULES,
  SECURITY_USER_RULES,
  SECURITY_DEFINER_RULES,
  CONFIG_RULES,
  PERFORMANCE_RULES,
] as const;

/** The id namespace each module owns. */
const MODULE_NAMESPACES: Record<string, string> = {
  sql: 'sql.',
  'query-schema': 'query-schema.',
  schema: 'schema.',
  security: 'security.',
  config: 'config.',
  // The performance module has always used the shorter `perf.` namespace.
  performance: 'perf.',
};

describe('rule registry', () => {
  it('exposes every rule with static metadata', () => {
    expect(RULE_CATALOG.length).toBeGreaterThan(100);
    for (const rule of RULE_CATALOG) {
      expect(rule.id).toMatch(/^[a-z-]+\.[a-z0-9-]+$/);
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.module.length).toBeGreaterThan(0);
      expect(['critical', 'high', 'medium', 'low', 'info']).toContain(rule.severity);
      expect([
        'correctness',
        'performance',
        'schema',
        'security',
        'config',
        'maintainability',
      ]).toContain(rule.category);
    }
  });

  it('has no duplicate rule ids', () => {
    // Duplicate ids would collapse distinct findings during deduplication.
    const ids = RULE_CATALOG.map((rule) => rule.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it('indexes rules by id', () => {
    expect(RULES_BY_ID.size).toBe(RULE_CATALOG.length);
    for (const rule of RULE_CATALOG) {
      expect(RULES_BY_ID.get(rule.id)).toEqual(rule);
    }
  });

  it('covers every module that runs rules', () => {
    const modules = new Set(RULE_CATALOG.map((rule) => rule.module));
    expect([...modules].sort()).toEqual([
      'config',
      'performance',
      'query-schema',
      'schema',
      'security',
      'sql',
    ]);
  });

  it('gives every rule a category the scorer can cap', () => {
    const categories = new Set(RULE_CATALOG.map((rule) => rule.category));
    expect(categories.size).toBeGreaterThan(1);
  });

  it('registers every rule of every rule set', () => {
    const ids = new Set(RULE_CATALOG.map((rule) => rule.id));
    for (const rules of RULE_SETS) {
      for (const rule of rules) {
        expect(ids.has(rule.meta.id)).toBe(true);
      }
    }
  });

  it('lists every rule the engine can emit', () => {
    // Every catalog entry is a rule of a rule set, or the unused-index rule
    // the audit produces from the server's index-usage statistics.
    const ruleIds = new Set(RULE_SETS.flatMap((rules) => rules.map((rule) => rule.meta.id)));
    for (const entry of RULE_CATALOG) {
      expect(ruleIds.has(entry.id) || entry.id === UNUSED_INDEX_RULE.id).toBe(true);
    }
  });

  it('namespaces every rule id by its module', () => {
    for (const entry of RULE_CATALOG) {
      expect(entry.id.startsWith(MODULE_NAMESPACES[entry.module])).toBe(true);
    }
  });
});
