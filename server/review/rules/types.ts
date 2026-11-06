import type { SchemaSnapshot, SchemaTable } from '../../../shared/types';
import type { Token } from '../tokenizer';
import type { StatementInfo } from '../sql-classifier';

export interface RuleContext {
  sql: string;
  tokens: Token[];
  statements: StatementInfo[];
  asts: unknown[];
  schema: SchemaSnapshot | null;
  tables: SchemaTable[];
  tableLookup: Map<string, SchemaTable>;
  referencedTables: string[];
  aliases: Map<string, string>;
  /**
   * Output columns of the CTEs and derived tables in the script, keyed by the
   * lower-cased CTE name or derived-table alias.
   *
   * A column that a CTE or a derived table exposes is not part of the base
   * schema, so it must not be reported as an unknown column.
   */
  virtualTables: Map<string, VirtualTable>;
}

/** A table whose columns come from the query itself, not from the schema. */
export interface VirtualTable {
  /** Lower-cased CTE name or derived-table alias. */
  name: string;
  /**
   * The output column names (lower-cased), or `null` when the full list is
   * unknown (e.g. `SELECT *` or an un-aliased expression).
   */
  columns: Set<string> | null;
}
