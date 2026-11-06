import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ServerCapabilities, ServerInfo, SqlFlavor } from '../../shared/types';

export type Queryable = Pool | PoolConnection;

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

export function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { major: 0, minor: 0, patch: 0 };
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function detectFlavor(version: string, comment: string): SqlFlavor {
  return /mariadb/i.test(version) || /mariadb/i.test(comment) ? 'mariadb' : 'mysql';
}

function atLeast(
  parts: { major: number; minor: number; patch: number },
  major: number,
  minor = 0,
  patch = 0,
): boolean {
  if (parts.major !== major) return parts.major > major;
  if (parts.minor !== minor) return parts.minor > minor;
  return parts.patch >= patch;
}

export async function getServerInfo(conn: Queryable): Promise<ServerInfo> {
  // Static statement; no user input is involved.
  const [rows] = await conn.query<Row[]>(
    `SELECT
       VERSION() AS version,
       @@version_comment AS version_comment,
       @@sql_mode AS sql_mode,
       DATABASE() AS current_db`,
  );
  const row = rows[0] ?? {};
  const version = String(row.version ?? 'unknown');
  const comment = String(row.version_comment ?? '');
  let uptime: number;
  try {
    const [uptimeRows] = await conn.query<Row[]>("SHOW GLOBAL STATUS LIKE 'Uptime'");
    uptime = Number(uptimeRows[0]?.Value ?? 0);
  } catch {
    uptime = 0;
  }
  const sqlMode = String(row.sql_mode ?? '');
  const currentDatabase = row.current_db == null ? null : String(row.current_db);
  const flavor = detectFlavor(version, comment);
  const parts = parseVersion(version);

  let performanceSchema: boolean;
  try {
    const [psRows] = await conn.query<Row[]>("SHOW VARIABLES LIKE 'performance_schema'");
    performanceSchema = String(psRows[0]?.Value ?? '').toUpperCase() === 'ON';
  } catch {
    performanceSchema = false;
  }

  let sysSchema: boolean;
  try {
    const [sysRows] = await conn.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'sys' LIMIT 1",
    );
    sysSchema = sysRows.length > 0;
  } catch {
    sysSchema = false;
  }

  const mariadb = flavor === 'mariadb';
  const capabilities: ServerCapabilities = {
    cte: mariadb ? atLeast(parts, 10, 2) : atLeast(parts, 8, 0),
    windowFunctions: mariadb ? atLeast(parts, 10, 2) : atLeast(parts, 8, 0),
    json: mariadb ? atLeast(parts, 10, 2, 1) : atLeast(parts, 5, 7, 8),
    checkConstraints: mariadb ? atLeast(parts, 10, 2, 1) : atLeast(parts, 8, 0, 16),
    roles: mariadb ? atLeast(parts, 10, 0, 5) : atLeast(parts, 8, 0),
    explainAnalyze: !mariadb && atLeast(parts, 8, 0, 18),
    analyzeFormatJson: mariadb ? atLeast(parts, 10, 1) : false,
    performanceSchema,
    sysSchema,
    replicaStatusCommand:
      !mariadb && atLeast(parts, 8, 0, 22) ? 'SHOW REPLICA STATUS' : 'SHOW SLAVE STATUS',
    mysql8: !mariadb && atLeast(parts, 8, 0),
  };

  return {
    flavor,
    version,
    versionComment: comment,
    uptimeSeconds: uptime,
    sqlMode,
    currentDatabase,
    capabilities,
  };
}

/** Applied once per physical pooled connection. */
export async function applyPoolSession(conn: PoolConnection): Promise<void> {
  try {
    await conn.query('SET SESSION group_concat_max_len = 1048576');
  } catch {
    // Non-fatal; old servers may not have the variable.
  }
}

export interface QueryGuards {
  cleanup: () => Promise<void>;
}

/**
 * How the server-side statement timeout is enforced.
 *
 * - `session-all`: the server aborts *any* statement that runs too long
 *   (MariaDB's `max_statement_time`).
 * - `session-select`: the server aborts long SELECTs only. MySQL's
 *   `max_execution_time` is documented to apply to read-only SELECT
 *   statements, so it cannot bound an UPDATE/DELETE/DDL.
 * - `watchdog`: the server has no session-wide statement timeout, so the
 *   caller has to kill the statement from a second connection.
 */
export type StatementTimeoutMode = 'session-all' | 'session-select' | 'watchdog';

export function resolveStatementTimeoutMode(
  flavor: SqlFlavor,
  isReadOnly: boolean,
): StatementTimeoutMode {
  if (flavor === 'mariadb') return 'session-all';
  return isReadOnly ? 'session-select' : 'watchdog';
}

export interface QueryGuardOptions {
  /**
   * The statement only reads. Read-only statements get MySQL's SELECT-only
   * timeout; everything else needs the watchdog.
   */
  isReadOnly?: boolean;
  /**
   * Apply the server-side row cap. Turn it off for copies that must move
   * every row of a table.
   */
  includeRowLimit?: boolean;
}

export async function applyQueryGuards(
  conn: Queryable,
  server: ServerInfo,
  settings: { rowLimit: number; queryTimeoutMs: number },
  options: QueryGuardOptions = {},
): Promise<QueryGuards> {
  const cleanupParts: string[] = [];
  const mode = resolveStatementTimeoutMode(server.flavor, options.isReadOnly ?? true);

  if (mode === 'session-all') {
    try {
      await conn.query('SET SESSION max_statement_time = ?', [
        Number((settings.queryTimeoutMs / 1000).toFixed(3)),
      ]);
      cleanupParts.push('SET SESSION max_statement_time = 0');
    } catch {
      // Variable unavailable; the client-side timeout still applies.
    }
  } else if (mode === 'session-select') {
    try {
      await conn.query('SET SESSION max_execution_time = ?', [Math.trunc(settings.queryTimeoutMs)]);
      cleanupParts.push('SET SESSION max_execution_time = 0');
    } catch {
      // Variable unavailable on older MySQL versions.
    }
  }

  if (options.includeRowLimit !== false) {
    try {
      await conn.query('SET SESSION sql_select_limit = ?', [
        Math.max(1, Math.trunc(settings.rowLimit)),
      ]);
      cleanupParts.push('SET SESSION sql_select_limit = DEFAULT');
    } catch {
      // Older/alternative servers may not support it; the UI still shows the cap.
    }
  }

  return {
    cleanup: async () => {
      for (const statement of cleanupParts) {
        try {
          await conn.query(statement);
        } catch {
          // The connection may be dead; never mask the original result.
        }
      }
    },
  };
}

/**
 * Extra time the client waits after the server-side deadline, so the kill
 * issued by the watchdog has a chance to land before the socket is torn down.
 */
export const WATCHDOG_KILL_GRACE_MS = 2_000;

export interface StatementWatchdog {
  /** Stops the watchdog. Safe to call more than once. */
  cancel: () => void;
}

/**
 * Abort a statement that overran its deadline. `KILL QUERY` stops the
 * statement but keeps the connection alive, which matters because MySQL has
 * no session-wide statement timeout: `max_execution_time` covers read-only
 * SELECT statements only.
 */
export async function killServerQuery(pool: Pool, threadId: number): Promise<void> {
  const killer = await pool.getConnection();
  try {
    await killer.query('KILL QUERY ?', [threadId]);
  } finally {
    killer.release();
  }
}

/**
 * Kill the statement running on `threadId` once `timeoutMs` has passed.
 * The kill is issued from a second pooled connection, so the connection that
 * runs the statement is the one that receives the error.
 */
export function startStatementWatchdog(options: {
  pool: Pool;
  threadId: number;
  timeoutMs: number;
  /** Called when the watchdog fires, before the kill is sent. */
  onKill?: () => void;
}): StatementWatchdog {
  const timer = setTimeout(() => {
    options.onKill?.();
    void killServerQuery(options.pool, options.threadId).catch(() => undefined);
  }, options.timeoutMs);
  timer.unref?.();
  return {
    cancel: () => clearTimeout(timer),
  };
}
