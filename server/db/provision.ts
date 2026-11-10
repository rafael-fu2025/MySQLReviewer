import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../errors';
import { getSettings } from '../store/settings';
import {
  applyQueryGuards,
  resolveStatementTimeoutMode,
  startStatementWatchdog,
  WATCHDOG_KILL_GRACE_MS,
} from './dialect';
import { connectProfile, getCachedServerInfo, getPool, withConnection } from './manager';

/**
 * Sandbox provisioning: when the admin assigns a database to a member, the
 * app clones it into `<source>_<n>` (counter per source database) so the
 * member has full write control without touching anyone else's data.
 *
 * Identifiers cannot be parameterized in SQL, so every identifier that reaches
 * an interpolated query passes through `assertIdentifier` first — a strict
 * allowlist that makes interpolation provably safe.
 */

interface NameRow extends RowDataPacket {
  name: string;
}

interface CharsetRow extends RowDataPacket {
  charset: string;
  collation: string;
}

interface TableRow extends RowDataPacket {
  name: string;
  row_count: number;
}

interface PrimaryKeyRow extends RowDataPacket {
  column_name: string;
  data_type: string;
}

interface KeyRow extends RowDataPacket {
  k: unknown;
}

const IDENTIFIER_RE = /^[A-Za-z0-9_$]+$/;

/** Rows copied per statement; keeps every copy statement short. */
const COPY_BATCH_SIZE = 1_000;

/**
 * Primary key types that can be used as a batch cursor. Anything else
 * (composite keys, blobs, JSON) is copied with a single statement.
 */
const BATCHABLE_KEY_TYPES = new Set([
  'int',
  'integer',
  'bigint',
  'smallint',
  'mediumint',
  'tinyint',
  'decimal',
  'numeric',
  'char',
  'varchar',
]);

export interface ProvisionResult {
  sandbox: string;
  tables: number;
  rowsCopied: number;
  /** Tables whose data copy failed; structure still exists. */
  dataErrors: string[];
  /** False when a table could not be copied completely. */
  complete: boolean;
}

/**
 * Validates that a name is a plain SQL identifier (letters, digits, `_`, `$`).
 * Exported so route handlers can run the same guard the SQL-generating
 * functions apply internally — the returned value is the safe one to use.
 */
export function assertIdentifier(name: string, label: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new AppError(
      'INVALID_NAME',
      `${label} must be a plain identifier (letters, digits, _ or $). Received: "${name}".`,
      400,
    );
  }
  return name;
}

function quoteIdentifier(name: string): string {
  assertIdentifier(name, 'Identifier');
  return `\`${name}\``;
}

async function existingDatabases(profileId: string): Promise<string[]> {
  const rows = await withConnection<NameRow[]>(profileId, async (conn) => {
    // SHOW DATABASES returns a `Database` column; alias through the
    // information_schema so the row shape stays predictable.
    const [result] = await conn.query<NameRow[]>(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA',
    );
    return result;
  });
  return rows.map((row) => row.name);
}

/**
 * Next free `<source>_<n>` name. The counter is per source database and
 * derived from what actually exists on the server, so clones made outside
 * the app never collide either.
 */
export async function nextSandboxName(profileId: string, source: string): Promise<string> {
  assertIdentifier(source, 'Source database');
  const databases = await existingDatabases(profileId);
  let max = 0;
  for (const name of databases) {
    const match = name.toLowerCase().match(/^(.+)_([0-9]+)$/);
    if (!match || match[1] !== source.toLowerCase()) continue;
    max = Math.max(max, Number.parseInt(match[2], 10));
  }
  return `${source}_${max + 1}`;
}

/**
 * Run one provisioning statement under a server-side deadline.
 *
 * MariaDB aborts the statement itself through `max_statement_time`, which
 * `applyQueryGuards` sets. MySQL has no session-wide statement timeout, so
 * the watchdog kills the statement from a second connection.
 */
async function runBounded<T>(
  conn: PoolConnection,
  pool: Pool | null,
  timeoutMs: number,
  statement: () => Promise<T>,
): Promise<T> {
  const watchdog = pool
    ? startStatementWatchdog({ pool, threadId: conn.threadId, timeoutMs })
    : null;
  try {
    return await statement();
  } finally {
    watchdog?.cancel();
  }
}

/**
 * The single-column primary key of a table, when it can be used as the
 * cursor of a batched copy. A composite key cannot: rows that share the
 * first key value would be skipped.
 */
async function singleColumnPrimaryKey(
  conn: PoolConnection,
  database: string,
  table: string,
): Promise<string | null> {
  const [rows] = await conn.query<PrimaryKeyRow[]>(
    `SELECT s.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type
       FROM information_schema.STATISTICS s
       JOIN information_schema.COLUMNS c
         ON c.TABLE_SCHEMA = s.TABLE_SCHEMA
        AND c.TABLE_NAME = s.TABLE_NAME
        AND c.COLUMN_NAME = s.COLUMN_NAME
      WHERE s.TABLE_SCHEMA = ? AND s.TABLE_NAME = ? AND s.INDEX_NAME = 'PRIMARY'
      ORDER BY s.SEQ_IN_INDEX`,
    [database, table],
  );
  if (rows.length !== 1) return null;
  const dataType = String(rows[0].data_type ?? '').toLowerCase();
  if (!BATCHABLE_KEY_TYPES.has(dataType)) return null;
  return assertIdentifier(String(rows[0].column_name), 'Primary key column');
}

/**
 * Copy the rows of one table into the sandbox.
 *
 * The copy runs in batches so no single statement runs unbounded. The batch is
 * a closed key range: the boundary key is read first, then the range between
 * the cursor and the boundary is copied. Ranges never skip or repeat a row
 * and do not rely on `ORDER BY`/`LIMIT` inside `INSERT ... SELECT`. Tables
 * without a usable single-column key are copied with one statement. Returns
 * the number of rows actually copied.
 */
async function copyTableData(
  conn: PoolConnection,
  pool: Pool | null,
  source: string,
  sandbox: string,
  table: string,
  keyColumn: string | null,
  timeoutMs: number,
): Promise<number> {
  const target = `${quoteIdentifier(sandbox)}.${quoteIdentifier(table)}`;
  const origin = `${quoteIdentifier(source)}.${quoteIdentifier(table)}`;

  const insertRange = async (where: string, values: unknown[]): Promise<number> => {
    const [header] = await runBounded(conn, pool, timeoutMs, () =>
      conn.query<ResultSetHeader>({
        sql: `INSERT INTO ${target} SELECT * FROM ${origin} ${where}`,
        values,
        timeout: timeoutMs + WATCHDOG_KILL_GRACE_MS,
      }),
    );
    return Number(header?.affectedRows ?? 0);
  };

  if (!keyColumn) {
    return insertRange('', []);
  }

  const key = quoteIdentifier(keyColumn);
  let cursor: unknown = null;
  let copied = 0;
  for (;;) {
    // The key that closes the next batch: the batchSize-th key after the cursor.
    const [keyRows] = await runBounded(conn, pool, timeoutMs, () =>
      conn.query<KeyRow[]>({
        sql: `SELECT ${key} AS k FROM ${origin} ${cursor === null ? '' : `WHERE ${key} > ?`}
              ORDER BY ${key} LIMIT 1 OFFSET ?`,
        values: cursor === null ? [COPY_BATCH_SIZE - 1] : [cursor, COPY_BATCH_SIZE - 1],
        timeout: timeoutMs + WATCHDOG_KILL_GRACE_MS,
      }),
    );
    const boundary = keyRows[0]?.k;
    if (boundary === undefined || boundary === null) {
      // Fewer than a batch of rows is left: copy the remainder.
      return (
        copied +
        (await insertRange(
          cursor === null ? '' : `WHERE ${key} > ?`,
          cursor === null ? [] : [cursor],
        ))
      );
    }
    copied += await insertRange(
      cursor === null ? `WHERE ${key} <= ?` : `WHERE ${key} > ? AND ${key} <= ?`,
      cursor === null ? [boundary] : [cursor, boundary],
    );
    cursor = boundary;
  }
}

export async function provisionSandbox(
  profileId: string,
  rawSource: string,
  rawSandbox: string,
  includeData: boolean,
): Promise<ProvisionResult> {
  const source = assertIdentifier(rawSource, 'Source database');
  const sandbox = assertIdentifier(rawSandbox, 'Sandbox database');
  const databases = await existingDatabases(profileId);
  if (!databases.some((name) => name.toLowerCase() === source.toLowerCase())) {
    throw new AppError(
      'DATABASE_NOT_FOUND',
      `The source database "${source}" does not exist on this connection.`,
      404,
    );
  }
  if (databases.some((name) => name.toLowerCase() === sandbox.toLowerCase())) {
    throw new AppError('DATABASE_EXISTS', `The sandbox database "${sandbox}" already exists.`, 409);
  }

  const result: ProvisionResult = {
    sandbox,
    tables: 0,
    rowsCopied: 0,
    dataErrors: [],
    complete: true,
  };

  await withConnection(profileId, async (conn) => {
    const settings = await getSettings();
    const server = getCachedServerInfo(profileId) ?? (await connectProfile(profileId));
    // Every copy statement runs under a server-side deadline. MariaDB aborts
    // the statement itself; MySQL has no session-wide statement timeout, so
    // the watchdog kills it from a second connection.
    const guards = await applyQueryGuards(
      conn,
      server,
      { rowLimit: settings.rowLimit, queryTimeoutMs: settings.queryTimeoutMs },
      { isReadOnly: false, includeRowLimit: false },
    );
    const timeoutMode = resolveStatementTimeoutMode(server.flavor, false);
    const pool: Pool | null = timeoutMode === 'watchdog' ? await getPool(profileId) : null;
    try {
      const [charsetRows] = await conn.query<CharsetRow[]>(
        `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
       FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
        [source],
      );
      // Charset/collation come from the server itself; still gated before use.
      const charset = assertIdentifier(charsetRows[0]?.charset ?? 'utf8mb4', 'Charset');
      const collation = assertIdentifier(
        charsetRows[0]?.collation ?? 'utf8mb4_general_ci',
        'Collation',
      );
      await runBounded(conn, pool, settings.queryTimeoutMs, () =>
        conn.query(
          `CREATE DATABASE ${quoteIdentifier(sandbox)} CHARACTER SET ${charset} COLLATE ${collation}`,
        ),
      );

      const [tableRows] = await conn.query<TableRow[]>(
        // `rows` is a reserved word in MariaDB, hence the row_count alias.
        `SELECT TABLE_NAME AS name, COALESCE(TABLE_ROWS, 0) AS row_count
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
        [source],
      );

      for (const table of tableRows) {
        const tableName = assertIdentifier(String(table.name), 'Table name');
        try {
          await runBounded(conn, pool, settings.queryTimeoutMs, () =>
            conn.query(
              `CREATE TABLE ${quoteIdentifier(sandbox)}.${quoteIdentifier(tableName)} LIKE ${quoteIdentifier(source)}.${quoteIdentifier(tableName)}`,
            ),
          );
          result.tables += 1;
          if (includeData) {
            const keyColumn = await singleColumnPrimaryKey(conn, source, tableName);
            result.rowsCopied += await copyTableData(
              conn,
              pool,
              source,
              sandbox,
              tableName,
              keyColumn,
              settings.queryTimeoutMs,
            );
          }
        } catch (error) {
          result.complete = false;
          result.dataErrors.push(
            `${tableName}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      await guards.cleanup();
    }
  });

  return result;
}

/**
 * Drops and re-clones an existing sandbox under the SAME name, so the
 * assignment keeps pointing at it. Only accepts names that match the
 * `<source>_<n>` pattern the provisioner generates.
 */
export async function resetSandbox(
  profileId: string,
  source: string,
  sandbox: string,
  includeData: boolean,
): Promise<ProvisionResult> {
  if (!sandbox.toLowerCase().startsWith(`${source.toLowerCase()}_`)) {
    throw new AppError('INVALID_NAME', `"${sandbox}" is not a sandbox of "${source}".`, 400);
  }
  await withConnection(profileId, async (conn) => {
    await conn.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sandbox)}`);
  });
  return provisionSandbox(profileId, source, sandbox, includeData);
}

export async function dropSandbox(profileId: string, sandbox: string): Promise<void> {
  await withConnection(profileId, async (conn) => {
    await conn.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sandbox)}`);
  });
}
