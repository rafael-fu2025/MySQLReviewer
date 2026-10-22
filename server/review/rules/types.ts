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
}
