import { describe, expect, it } from 'vitest';
import { RULE_CATALOG, RULES_BY_ID } from '../server/review/rules';

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
});
