import type { SchemaSnapshot, SchemaTable, ServerInfo } from '../../../shared/types';
import type { Token } from '../tokenizer';
import type { StatementInfo } from '../sql-classifier';

export interface RuleContext {
  sql: string;
  tokens: Token[];
  statements: StatementInfo[];
  asts: unknown[];
  ast: unknown | null;
  schema: SchemaSnapshot | null;
  database: string | null;
  tables: SchemaTable[];
  tableLookup: Map<string, SchemaTable>;
  referencedTables: string[];
  aliases: Map<string, string>;
  server: ServerInfo | null;
  analyzed: boolean;
}

export type RuleScope = 'sql' | 'schema' | 'security' | 'config' | 'explain';
