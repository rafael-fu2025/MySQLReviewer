import sqlParser from 'node-sql-parser';
import type {
  ReviewContextInfo,
  ReviewTableContext,
  SchemaSnapshot,
  SchemaTable,
} from '../../shared/types';
import { classifySql } from './sql-classifier';
import { significantTokens, tokenize } from './tokenizer';
import type { RuleContext } from './rules/types';

const parserModule = sqlParser as unknown as typeof import('node-sql-parser');
const parser = new parserModule.Parser();

function parseAst(sql: string): unknown | null {
  try {
    const ast = parser.astify(sql, { database: 'MySQL' });
    return Array.isArray(ast) ? ast[0] : ast;
  } catch {
    return null;
  }
}

interface FromRef {
  table: string;
  db: string | null;
  alias: string | null;
}

function collectFromEntries(value: unknown, out: FromRef[]): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.table === 'string' && record.column === undefined) {
      out.push({
        table: record.table,
        db: record.db == null ? null : String(record.db),
        alias: record.as == null ? null : String(record.as),
      });
    }
  }
}

function walkAst(node: unknown, out: FromRef[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  collectFromEntries(record.from, out);
  collectFromEntries(record.table, out);
  for (const value of Object.values(record)) walkAst(value, out);
}

function collectCteNames(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectCteNames(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const withNode = record.with;
  if (withNode) {
    const entries = Array.isArray(withNode) ? withNode : [withNode];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const nameNode = (entry as Record<string, unknown>).name;
      if (typeof nameNode === 'string') out.add(nameNode.toLowerCase());
      else if (nameNode && typeof nameNode === 'object') {
        const value = (nameNode as Record<string, unknown>).value;
        if (typeof value === 'string') out.add(value.toLowerCase());
      }
    }
  }
  for (const value of Object.values(record)) collectCteNames(value, out);
}

export interface BuildContextInput {
  sql: string;
  schema: SchemaSnapshot | null;
}

export function buildRuleContext(input: BuildContextInput): RuleContext {
  const classified = classifySql(input.sql);
  const tokens = significantTokens(tokenize(input.sql));
  const asts: unknown[] = [];
  for (const statement of classified.statements) {
    asts.push(parseAst(statement.sql));
  }

  const refs: FromRef[] = [];
  for (const ast of asts) walkAst(ast, refs);

  const cteNames = new Set<string>();
  for (const ast of asts) collectCteNames(ast, cteNames);

  const referencedTables: string[] = [];
  const aliases = new Map<string, string>();
  const tableLookup = new Map<string, SchemaTable>();
  const tables: SchemaTable[] = [];
  const seen = new Set<string>();

  if (input.schema) {
    const byName = new Map<string, SchemaTable>();
    for (const table of input.schema.tables) {
      byName.set(table.name.toLowerCase(), table);
      byName.set(`${table.database.toLowerCase()}.${table.name.toLowerCase()}`, table);
    }
    for (const ref of refs) {
      if (cteNames.has(ref.table.toLowerCase())) continue;
      const qualified = ref.db
        ? `${ref.db.toLowerCase()}.${ref.table.toLowerCase()}`
        : ref.table.toLowerCase();
      const table = byName.get(qualified) ?? byName.get(ref.table.toLowerCase());
      if (!table) continue;
      if (!seen.has(`${table.database}.${table.name}`)) {
        seen.add(`${table.database}.${table.name}`);
        tables.push(table);
        referencedTables.push(table.name);
      }
      tableLookup.set(ref.table.toLowerCase(), table);
      tableLookup.set(
        `${(ref.db ?? table.database).toLowerCase()}.${ref.table.toLowerCase()}`,
        table,
      );
      if (ref.alias) tableLookup.set(ref.alias.toLowerCase(), table);
      if (ref.alias) aliases.set(ref.alias.toLowerCase(), table.name);
      aliases.set(table.name.toLowerCase(), table.name);
    }

    if (tables.length === 0) {
      // Fallback for SQL the parser could not parse: match identifiers to schema names.
      const words = new Set(
        tokens.filter((token) => token.kind === 'word').map((token) => token.value.toLowerCase()),
      );
      for (const table of input.schema.tables) {
        if (words.has(table.name.toLowerCase())) {
          tables.push(table);
          referencedTables.push(table.name);
          tableLookup.set(table.name.toLowerCase(), table);
        }
      }
    }
  } else {
    for (const ref of refs) {
      if (cteNames.has(ref.table.toLowerCase())) continue;
      const key = `${ref.db ? `${ref.db}.` : ''}${ref.table}`;
      if (!seen.has(key)) {
        seen.add(key);
        referencedTables.push(ref.table);
      }
      if (ref.alias) aliases.set(ref.alias.toLowerCase(), ref.table);
    }
  }

  return {
    sql: input.sql,
    tokens,
    statements: classified.statements,
    asts,
    schema: input.schema,
    tables,
    tableLookup,
    referencedTables,
    aliases,
  };
}

function ident(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

export function schemaToText(tables: SchemaTable[], maxChars = 24_000): string {
  const lines: string[] = [];
  for (const table of tables) {
    lines.push(
      `TABLE ${ident(table.database)}.${ident(table.name)} (engine=${table.engine ?? 'unknown'}, rows≈${table.rowsEstimate}, charset=${table.charset ?? 'n/a'})`,
    );
    for (const column of table.columns) {
      const bits = [
        ident(column.name),
        column.columnType || column.dataType,
        column.nullable ? 'NULL' : 'NOT NULL',
      ];
      if (column.key) bits.push(`key=${column.key}`);
      if (column.extra) bits.push(column.extra);
      if (column.defaultValue != null) bits.push(`default=${column.defaultValue}`);
      lines.push(`  ${bits.join(' ')}`);
    }
    for (const index of table.indexes) {
      const cols = index.columns
        .map((column) => `${ident(column.name)}${column.subPart ? `(${column.subPart})` : ''}`)
        .join(', ');
      lines.push(
        `  ${index.unique ? 'UNIQUE KEY' : 'KEY'} ${ident(index.name)} (${cols})${index.type !== 'BTREE' ? ` USING ${index.type}` : ''}`,
      );
    }
    for (const fk of table.foreignKeys) {
      lines.push(
        `  FOREIGN KEY ${ident(fk.name)} (${fk.columns.map(ident).join(', ')}) REFERENCES ${ident(fk.referencedDatabase)}.${ident(fk.referencedTable)} (${fk.referencedColumns.map(ident).join(', ')}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`,
      );
    }
    lines.push('');
  }
  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n-- [schema context truncated]`;
  }
  return text;
}

export function buildContextInfo(
  tables: SchemaTable[],
  database: string | null,
  maxTables = 8,
  maxChars = 24_000,
): ReviewContextInfo {
  const included = tables.slice(0, maxTables);
  const infoTables: ReviewTableContext[] = included.map((table) => ({
    database: table.database,
    table: table.name,
    engine: table.engine,
    rowsEstimate: table.rowsEstimate,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.columnType || column.dataType,
      nullable: column.nullable,
      key: column.key,
      extra: column.extra,
      defaultValue: column.defaultValue,
    })),
    indexes: table.indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      columns: index.columns.map((column) => column.name),
    })),
    foreignKeys: table.foreignKeys.map((fk) => ({
      name: fk.name,
      columns: fk.columns,
      referencedTable: fk.referencedTable,
      referencedColumns: fk.referencedColumns,
    })),
  }));
  const fullText = schemaToText(included, 1_000_000);
  const text = schemaToText(included, maxChars);
  return {
    database,
    tables: infoTables,
    truncated: tables.length > included.length || fullText.length > maxChars,
    charCount: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
  };
}

export function getAliasTable(
  context: RuleContext,
  alias: string | null | undefined,
): SchemaTable | null {
  if (!alias) return null;
  return context.tableLookup.get(alias.toLowerCase()) ?? null;
}
