import type { RowDataPacket } from 'mysql2/promise';

import type { TableSummary } from '../../shared/types';
import { withConnection } from './manager';
import { getDatabaseObjects } from './introspection';
import { quoteIdent } from './security-audit';
import { classifySql } from '../review/sql-classifier';
import { significantTokens, tokenize } from '../review/tokenizer';

/**
 * A dump is a script, not a data channel: every statement in it is a plain
 * SQL statement that the caller reviews and then runs through the ordinary
 * gates (write unlock, member scope, masking). Nothing here executes anything.
 */

/** Rows read per round trip while dumping a table. */
const DATA_PAGE_SIZE = 500;

/** A table is dumped in batches of this many rows per INSERT. */
const INSERT_BATCH = 200;

/**
 * Render a value as a SQL literal.
 *
 * MySQL's default SQL mode treats a backslash as an escape character, so a
 * backslash has to be doubled. A quote is doubled as well, which is correct
 * in either SQL mode. Anything that is not a plain string - a number, a
 * boolean, a binary buffer, NULL - is rendered in its own natural form.
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (typeof value === 'object' && 'toString' in value) {
    // A DATE / DATETIME / DECIMAL arrives as a string-like object.
    return sqlLiteral(String(value));
  }
  const text = String(value);
  let out = '';
  for (const ch of text) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case "'":
        out += "''";
        break;
      case '\0':
        out += '\\0';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\x1a':
        out += '\\Z';
        break;
      default:
        out += ch;
    }
  }
  return `'${out}'`;
}

/**
 * Drop the `DEFINER=...` clause from a routine or trigger definition.
 *
 * The dump is meant to be loadable somewhere else, and the account that
 * created the object usually does not exist there. mysqldump calls this
 * `--skip-definer`.
 *
 * The clause is `DEFINER=<user>@<host>`, and each half may be backticked,
 * quoted or bare. The `SQL SECURITY DEFINER` that follows it is a different
 * clause and must stay.
 */
export function stripDefiner(createSql: string): string {
  return createSql.replace(
    /DEFINER=(?:`[^`]*`|'[^']*'|[^\s@]+)(?:@(?:`[^`]*`|'[^']*'|[^\s]+))?[ \t]*/gi,
    '',
  );
}

export interface ExportOptions {
  /** Include the rows of every table. */
  includeData?: boolean;
  /** Include views, triggers, routines and events. */
  includeObjects?: boolean;
  /** Stop after this many rows per table; 0 means no limit. */
  rowLimit?: number;
}

export interface ExportStats {
  tables: number;
  views: number;
  triggers: number;
  routines: number;
  rows: number;
  bytes: number;
}

export interface ExportResult {
  sql: string;
  filename: string;
  stats: ExportStats;
  /** Objects that could not be read and are therefore not in the dump. */
  warnings: string[];
}

/** One statement of an imported script, with the gate it would have to pass. */
export interface ImportStatement {
  sql: string;
  kind: string;
  needsUnlock: boolean;
  destructive: boolean;
  reason?: string;
  /**
   * True when the statement only changes session state - `SET`, `USE`, or
   * nothing but a comment.
   */
  session: boolean;
}

export interface ImportPreview {
  statements: ImportStatement[];
  /** How many statements need the write unlock before they can run. */
  needsUnlockCount: number;
  /** Statements that change data or schema. */
  destructiveCount: number;
  /** True when the script contains a `DELIMITER` directive. */
  hasDelimiter: boolean;
  /** How many statements only change session state. */
  sessionCount: number;
  /** The destructive statements, so the caller can warn about them by name. */
  destructiveStatements: string[];
  bytes: number;
}

/**
 * Whether a statement only changes session state.
 *
 * A real `mysqldump` file is full of them: `SET FOREIGN_KEY_CHECKS = 0`,
 * `SET @OLD_… = …`, a `USE otherdb`, and the `/*!40101 SET … *\/` version
 * comments. They configure the session that loads the file rather than
 * changing anything, and the in-app import runs every statement on its own -
 * so a `USE` would be refused by the scope check and a `SET` would do nothing
 * useful. `SET PASSWORD` is the exception: it changes an account, so it is a
 * real statement.
 */
export function isSessionStatement(sql: string): boolean {
  const words = significantTokens(tokenize(sql)).filter((token) => token.kind === 'word');
  const first = words[0];
  if (!first) return true; // nothing but a comment
  const keyword = first.value.toUpperCase();
  if (keyword === 'USE') return true;
  if (keyword === 'SET') {
    // `SET PASSWORD` changes an account; `SET` anything else is a variable.
    const second = words[1];
    return !(second && second.value.toUpperCase() === 'PASSWORD');
  }
  return false;
}

/**
 * Whether a statement is a stored routine: a compound block whose body holds
 * semicolons of its own.
 */
export function looksLikeCompoundStatement(sql: string): boolean {
  if (!/^\s*(?:create|alter)\b/i.test(sql)) return false;
  return /\bbegin\b/i.test(sql) && /\bend\b/i.test(sql);
}

/**
 * The text to send for one imported statement.
 *
 * A routine body holds semicolons, so it only stays one statement while the
 * terminator is changed around it. The `DELIMITER` wrapper is re-applied
 * here: the server splits the wrapper the same way the import did, and the
 * body arrives as a single statement.
 */
export function sendableStatementText(sql: string): string {
  if (!looksLikeCompoundStatement(sql)) return sql;
  // A terminator that cannot occur in the body. `;;` is the usual choice; it
  // is extended if the body happens to contain it.
  let terminator = ';;';
  while (sql.includes(terminator)) terminator += ';';
  return `DELIMITER ${terminator}\n${sql}\n${terminator}`;
}

/**
 * Split an imported script into the statements it holds and classify each one.
 *
 * The script is only read, never run: the caller shows the statements and
 * then executes them one at a time through the ordinary query path.
 */
export function previewImportScript(sql: string): ImportPreview {
  const classified = classifySql(sql);
  const statements: ImportStatement[] = classified.statements.map((statement) => ({
    sql: sendableStatementText(statement.sql),
    kind: statement.classification.kind,
    needsUnlock: statement.classification.needsUnlock,
    destructive: statement.classification.destructive,
    reason: statement.classification.reason,
    session: isSessionStatement(statement.sql),
  }));
  return {
    statements,
    needsUnlockCount: statements.filter((statement) => statement.needsUnlock).length,
    destructiveCount: statements.filter((statement) => statement.destructive).length,
    hasDelimiter: /^\s*delimiter\b/im.test(sql),
    sessionCount: statements.filter((statement) => statement.session).length,
    destructiveStatements: statements
      .filter((statement) => statement.destructive)
      .map((statement) => statement.sql.split('\n')[0].trim())
      .filter((line) => line.length > 0),
    bytes: Buffer.byteLength(sql, 'utf8'),
  };
}

/**
 * Build a `.sql` dump of one database: the schema of every table, the rows of
 * every table, and the views, triggers and routines that belong to it.
 *
 * The output is a plain script. It is not executed here, and when it is
 * imported it is reviewed statement by statement before anything runs.
 */
export async function exportDatabaseSql(
  profileId: string,
  database: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const includeData = options.includeData === true;
  const includeObjects = options.includeObjects !== false;
  const rowLimit = Math.max(0, Math.trunc(options.rowLimit ?? 0));

  const objects = await getDatabaseObjects(profileId, database);
  const baseTables = orderByForeignKey(
    objects.tables.filter((table) => table.type === 'BASE TABLE'),
    await foreignKeyEdges(profileId, database),
  );
  const views = objects.views;

  const chunks: string[] = [];
  const warnings: string[] = [];
  const stats: ExportStats = {
    tables: baseTables.length,
    views: views.length,
    triggers: objects.triggers.length,
    routines: objects.routines.length,
    rows: 0,
    bytes: 0,
  };

  chunks.push(
    '-- MyLens database export',
    `-- Database: ${database}`,
    `-- Generated: ${new Date().toISOString()}`,
    '--',
    '-- Import this file with "Import SQL": the statements are shown for review',
    '-- and then run one at a time through the ordinary gates.',
    '',
    'SET FOREIGN_KEY_CHECKS = 0;',
    "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
    "SET TIME_ZONE = '+00:00';",
    '',
  );

  await withConnection(profileId, async (conn) => {
    for (const table of baseTables) {
      const name = table.name;
      chunks.push(
        '--',
        `-- Table structure for table \`${name}\``,
        '--',
        '',
        `DROP TABLE IF EXISTS ${quoteIdent(name)};`,
      );
      const create = await showCreate(conn, database, 'TABLE', name);
      if (!create) {
        warnings.push(`Could not read the definition of table ${name}.`);
        continue;
      }
      chunks.push(`${stripDefiner(create)};`, '');
      if (!includeData) continue;
      const { rows, statements } = await dumpRows(conn, database, name, rowLimit);
      stats.rows += rows;
      if (statements.length > 0) {
        chunks.push('--', `-- Data for table \`${name}\``, '--', '', ...statements, '');
      }
    }

    if (includeObjects) {
      for (const view of views) {
        chunks.push(
          '--',
          `-- View \`${view.name}\``,
          '--',
          '',
          `DROP VIEW IF EXISTS ${quoteIdent(view.name)};`,
        );
        const create = await showCreate(conn, database, 'VIEW', view.name);
        if (!create) {
          warnings.push(`Could not read the definition of view ${view.name}.`);
          continue;
        }
        chunks.push(`${stripDefiner(create)};`, '');
      }

      for (const trigger of objects.triggers) {
        chunks.push(
          '--',
          `-- Trigger \`${trigger.name}\``,
          '--',
          '',
          `DROP TRIGGER IF EXISTS ${quoteIdent(trigger.name)};`,
          'DELIMITER ;;',
        );
        const create = await showCreate(conn, database, 'TRIGGER', trigger.name);
        if (!create) {
          warnings.push(`Could not read the definition of trigger ${trigger.name}.`);
          continue;
        }
        chunks.push(`${stripDefiner(create)} ;;`, 'DELIMITER ;', '');
      }

      for (const routine of objects.routines) {
        chunks.push(
          '--',
          `-- ${routine.type} \`${routine.name}\``,
          '--',
          '',
          `DROP ${routine.type} IF EXISTS ${quoteIdent(routine.name)};`,
          'DELIMITER ;;',
        );
        const create = await showCreate(conn, database, routine.type, routine.name);
        if (!create) {
          warnings.push(`Could not read the definition of ${routine.type} ${routine.name}.`);
          continue;
        }
        chunks.push(`${stripDefiner(create)} ;;`, 'DELIMITER ;', '');
      }
    }
  });

  chunks.push('SET FOREIGN_KEY_CHECKS = 1;', '');
  const sql = chunks.join('\n');
  stats.bytes = Buffer.byteLength(sql, 'utf8');
  return {
    sql,
    filename: `${database}.sql`,
    stats,
    warnings,
  };
}

/** The part of a pooled connection this module needs. */
interface DumpConnection {
  query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
}

/**
 * The foreign-key edges of one database: for each child table, the tables it
 * points at.
 */
async function foreignKeyEdges(
  profileId: string,
  database: string,
): Promise<Map<string, Set<string>>> {
  const edges = new Map<string, Set<string>>();
  await withConnection(profileId, async (conn) => {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [database],
    );
    for (const row of rows as RowDataPacket[]) {
      const child = String(row.child);
      const parent = String(row.parent);
      if (!edges.has(child)) edges.set(child, new Set());
      edges.get(child)!.add(parent);
    }
  });
  return edges;
}

/**
 * Order the tables so that a table always comes after every table it points
 * at.
 *
 * The dump has to load in that order, or a foreign key fails before the table
 * it points at exists. The dump's `SET FOREIGN_KEY_CHECKS = 0` cannot be
 * relied on: the import runs the statements one at a time, and each one may
 * land on a different pooled connection, where the session setting does not
 * apply. Tables that take part in a cycle keep their original order, because
 * no order can satisfy a cycle.
 */
export function orderByForeignKey(
  tables: TableSummary[],
  edges: Map<string, Set<string>>,
): TableSummary[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const ordered: TableSummary[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (table: TableSummary): void => {
    if (done.has(table.name) || visiting.has(table.name)) return;
    visiting.add(table.name);
    for (const parent of edges.get(table.name) ?? []) {
      const parentTable = byName.get(parent);
      if (parentTable) visit(parentTable);
    }
    visiting.delete(table.name);
    done.add(table.name);
    ordered.push(table);
  };

  for (const table of tables) visit(table);
  return ordered;
}

/** `SHOW CREATE <kind> <name>` for one object. */
async function showCreate(
  conn: DumpConnection,
  database: string,
  kind: 'TABLE' | 'VIEW' | 'TRIGGER' | 'PROCEDURE' | 'FUNCTION',
  name: string,
): Promise<string | null> {
  // The database has to be named: a pooled connection sits in the profile's
  // default database, not necessarily the one being dumped.
  const [rows] = await conn.query(
    `SHOW CREATE ${kind} ${quoteIdent(database)}.${quoteIdent(name)}`,
  );
  const row = (rows as RowDataPacket[])[0] as Record<string, string> | undefined;
  if (!row) return null;
  // The column is named `Create Table`, `Create View`, `Create Trigger`,
  // `Create Procedure`, `Create Function` - the case follows the server, so
  // it is matched case-insensitively.
  const wanted = `create ${kind}`.toLowerCase();
  const key = Object.keys(row).find((column) => column.toLowerCase() === wanted);
  const value = key ? row[key] : undefined;
  return typeof value === 'string' ? value : null;
}

/**
 * Read the rows of one table and render them as INSERT statements.
 */
async function dumpRows(
  conn: DumpConnection,
  database: string,
  table: string,
  rowLimit: number,
): Promise<{ rows: number; statements: string[] }> {
  const statements: string[] = [];
  let total = 0;
  let offset = 0;
  let columns: string[] = [];

  for (;;) {
    const limit = rowLimit > 0 ? Math.min(DATA_PAGE_SIZE, rowLimit - total) : DATA_PAGE_SIZE;
    if (limit <= 0) break;
    const [rows, fields] = await conn.query(
      `SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)} LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    const list = rows as RowDataPacket[];
    if (list.length === 0) break;
    if (columns.length === 0) {
      columns = (fields as { name: string }[]).map((field) => field.name);
    }
    const columnList = columns.map((column) => quoteIdent(column)).join(', ');
    for (let start = 0; start < list.length; start += INSERT_BATCH) {
      const batch = list.slice(start, start + INSERT_BATCH);
      const values = batch
        .map((row) => `(${columns.map((column) => sqlLiteral(row[column])).join(', ')})`)
        .join(',\n  ');
      statements.push(`INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES\n  ${values};`);
    }
    total += list.length;
    offset += list.length;
    if (list.length < limit) break;
  }

  return { rows: total, statements };
}
