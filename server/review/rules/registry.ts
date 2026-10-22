import { describeRules, type RuleCatalogEntry } from './descriptor';
import { SQL_SCRIPT_HEAD_RULES, SQL_SCRIPT_TAIL_RULES, SQL_STATEMENT_RULES } from './sql-rules';
import { QUERY_SCHEMA_RULES } from './query-schema-rules';
import { SCHEMA_RULES } from './schema-rules';
import { SECURITY_DEFINER_RULES, SECURITY_USER_RULES } from './security-rules';
import { CONFIG_RULES } from './config-rules';
import { PERFORMANCE_RULES } from './performance-rules';

/**
 * Every rule the engine can run, with its static metadata.
 *
 * The catalog is the single place to look up what rules exist, which module
 * owns them, and how severe they are. It is derived from the rule sets
 * themselves, so adding a rule to a module adds it here automatically.
 */
export const RULE_CATALOG: RuleCatalogEntry[] = [
  ...describeRules('sql', SQL_STATEMENT_RULES),
  ...describeRules('sql', SQL_SCRIPT_HEAD_RULES),
  ...describeRules('sql', SQL_SCRIPT_TAIL_RULES),
  ...describeRules('query-schema', QUERY_SCHEMA_RULES),
  ...describeRules('schema', SCHEMA_RULES),
  ...describeRules('security', SECURITY_USER_RULES),
  ...describeRules('security', SECURITY_DEFINER_RULES),
  ...describeRules('config', CONFIG_RULES),
  ...describeRules('performance', PERFORMANCE_RULES),
];

/** Rules indexed by id, for lookup by consumers that need rule metadata. */
export const RULES_BY_ID: ReadonlyMap<string, RuleCatalogEntry> = new Map(
  RULE_CATALOG.map((rule) => [rule.id, rule]),
);
