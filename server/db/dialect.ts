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
  let uptime = 0;
  try {
    const [uptimeRows] = await conn.query<Row[]>(
      "SHOW GLOBAL STATUS LIKE 'Uptime'",
    );
    uptime = Number(uptimeRows[0]?.Value ?? 0);
  } catch {
    uptime = 0;
  }
  const sqlMode = String(row.sql_mode ?? '');
  const currentDatabase = row.current_db == null ? null : String(row.current_db);
  const flavor = detectFlavor(version, comment);
  const parts = parseVersion(version);

  let performanceSchema = false;
  try {
    const [psRows] = await conn.query<Row[]>(
      "SHOW VARIABLES LIKE 'performance_schema'",
    );
    performanceSchema = String(psRows[0]?.Value ?? '').toUpperCase() === 'ON';
  } catch {
    performanceSchema = false;
  }

  let sysSchema = false;
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

export async function applyQueryGuards(
  conn: Queryable,
  server: ServerInfo,
  settings: { rowLimit: number; queryTimeoutMs: number },
): Promise<QueryGuards> {
  const cleanupParts: string[] = [];

  if (server.flavor === 'mariadb') {
    try {
      await conn.query('SET SESSION max_statement_time = ?', [
        Number((settings.queryTimeoutMs / 1000).toFixed(3)),
      ]);
      cleanupParts.push('SET SESSION max_statement_time = 0');
    } catch {
      // Variable unavailable; the client-side timeout still applies.
    }
  } else {
    try {
      await conn.query('SET SESSION max_execution_time = ?', [
        Math.trunc(settings.queryTimeoutMs),
      ]);
      cleanupParts.push('SET SESSION max_execution_time = 0');
    } catch {
      // Variable unavailable on older MySQL versions.
    }
  }

  try {
    await conn.query('SET SESSION sql_select_limit = ?', [
      Math.max(1, Math.trunc(settings.rowLimit)),
    ]);
    cleanupParts.push('SET SESSION sql_select_limit = DEFAULT');
  } catch {
    // Older/alternative servers may not support it; the UI still shows the cap.
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
