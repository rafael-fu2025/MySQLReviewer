import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import type {
  PerformanceMetrics,
  PerformanceSnapshot,
  ProcessInfo,
  ReplicationStatus,
  SlowQueryInfo,
} from '../../shared/types';
import { getCachedServerInfo, connectProfile, withConnection } from './manager';
import { getTopTables } from './introspection';

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getGlobalStatus(profileId: string): Promise<Record<string, string>> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>('SHOW GLOBAL STATUS');
    return result;
  });
  const out: Record<string, string> = {};
  for (const row of rows) out[str(row.Variable_name)] = str(row.Value);
  return out;
}

export async function getGlobalVariables(profileId: string): Promise<Record<string, string>> {
  return withConnection(profileId, async (conn) => {
    const [rows] = await conn.query<Row[]>('SHOW GLOBAL VARIABLES');
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[str(row.Variable_name)] =
        row.Value == null ? 'NULL' : String(row.Value);
    }
    // SHOW VARIABLES reports NULL as an empty string on some MariaDB builds.
    // Read the two security-sensitive values directly to preserve NULL.
    try {
      const [special] = await conn.query<Row[]>(
        'SELECT @@secure_file_priv AS secure_file_priv, @@bind_address AS bind_address',
      );
      if (special[0]) {
        out.secure_file_priv =
          special[0].secure_file_priv == null
            ? 'NULL'
            : String(special[0].secure_file_priv);
        out.bind_address =
          special[0].bind_address == null
            ? 'NULL'
            : String(special[0].bind_address);
      }
    } catch {
      // Keep the SHOW VARIABLES values if the direct read is unavailable.
    }
    return out;
  });
}

export async function getProcessList(profileId: string): Promise<ProcessInfo[]> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>('SHOW FULL PROCESSLIST');
    return result;
  });
  return rows.map((row) => ({
    id: num(row.Id),
    user: str(row.User),
    host: str(row.Host),
    db: row.db == null ? null : str(row.db),
    command: str(row.Command),
    timeSeconds: num(row.Time),
    state: row.State == null ? null : str(row.State),
    info: row.Info == null ? null : str(row.Info).slice(0, 4_000),
  }));
}

export function computeMetrics(status: Record<string, string>): PerformanceMetrics {
  const n = (key: string): number => num(status[key]);
  const uptimeSeconds = n('Uptime');
  const questions = n('Questions');
  const readRequests = n('Innodb_buffer_pool_read_requests');
  const physicalReads = n('Innodb_buffer_pool_reads');
  return {
    uptimeSeconds,
    qps: uptimeSeconds > 0 ? questions / uptimeSeconds : 0,
    threadsConnected: n('Threads_connected'),
    threadsRunning: n('Threads_running'),
    maxUsedConnections: n('Max_used_connections'),
    abortedConnects: n('Aborted_connects'),
    abortedClients: n('Aborted_clients'),
    slowQueries: n('Slow_queries'),
    selectScan: n('Select_scan'),
    selectFullJoin: n('Select_full_join'),
    tmpDiskTables: n('Created_tmp_disk_tables'),
    tmpTables: n('Created_tmp_tables'),
    bufferPoolHitRatio: readRequests > 0 ? 1 - physicalReads / readRequests : null,
    tableLocksWaited: n('Table_locks_waited'),
    innodbDeadlocks: n('Innodb_deadlocks'),
    bytesReceived: n('Bytes_received'),
    bytesSent: n('Bytes_sent'),
    openTables: n('Open_tables'),
    queries: questions,
  };
}

function normalizeSlowSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'[^']*'/g, '?')
    .replace(/"[^"]*"/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_500);
}

async function readSlowLog(file: string, datadir: string): Promise<SlowQueryInfo[]> {
  const resolved = path.isAbsolute(file) ? file : path.join(datadir, file);
  const stat = await fs.stat(resolved);
  const maxTail = 4 * 1024 * 1024;
  const start = Math.max(0, stat.size - maxTail);
  const handle = await fs.open(resolved, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    const blocks = text.split(/# Time: /).slice(1);
    const grouped = new Map<
      string,
      {
        normalized: string;
        count: number;
        totalMs: number;
        maxMs: number;
        rowsExamined: number;
        rowsSent: number;
        firstSeen: string | null;
        lastSeen: string | null;
      }
    >();

    for (const block of blocks) {
      const timeMatch = block.match(/^([^\n]+)/);
      const queryTime = block.match(/Query_time:\s*([0-9.]+)/);
      if (!queryTime) continue;
      const rowsSent = block.match(/Rows_sent:\s*(\d+)/);
      const rowsExamined = block.match(/Rows_examined:\s*(\d+)/);
      const timestamp = timeMatch ? timeMatch[1].trim() : null;
      const sqlMatch = block.match(/(?:^|\n)(?:use\s+[^;]+;\s*)?(SELECT[\s\S]*?|INSERT[\s\S]*?|UPDATE[\s\S]*?|DELETE[\s\S]*?|REPLACE[\s\S]*?|ALTER[\s\S]*?|CREATE[\s\S]*?|DROP[\s\S]*?);?\s*$/i);
      const sql = sqlMatch ? sqlMatch[1] : '';
      if (!sql) continue;
      const normalized = normalizeSlowSql(sql);
      if (!normalized) continue;
      const existing = grouped.get(normalized) ?? {
        normalized,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        rowsExamined: 0,
        rowsSent: 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
      };
      const ms = Number.parseFloat(queryTime[1]) * 1000;
      existing.count += 1;
      existing.totalMs += ms;
      existing.maxMs = Math.max(existing.maxMs, ms);
      existing.rowsSent += num(rowsSent?.[1]);
      existing.rowsExamined += num(rowsExamined?.[1]);
      existing.lastSeen = timestamp ?? existing.lastSeen;
      grouped.set(normalized, existing);
    }

    return Array.from(grouped.values())
      .sort((a, b) => b.maxMs - a.maxMs)
      .slice(0, 20)
      .map((item) => ({
        digest: crypto.createHash('sha1').update(item.normalized).digest('hex').slice(0, 16),
        digestText: item.normalized,
        schemaName: null,
        count: item.count,
        avgLatencyMs: item.count > 0 ? item.totalMs / item.count : 0,
        maxLatencyMs: item.maxMs,
        rowsExamined: item.rowsExamined,
        rowsSent: item.rowsSent,
        firstSeen: item.firstSeen,
        lastSeen: item.lastSeen,
      }));
  } finally {
    await handle.close();
  }
}

async function getSlowQueries(
  profileId: string,
  performanceSchema: boolean,
  variables: Record<string, string>,
): Promise<{ rows: SlowQueryInfo[]; source: 'performance_schema' | 'slow_log' | 'none'; advice: string | null }> {
  if (performanceSchema) {
    try {
      const rows = await withConnection(profileId, async (conn) => {
        const [result] = await conn.query<Row[]>(
          `SELECT SCHEMA_NAME, DIGEST, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT,
                  AVG_TIMER_WAIT, MAX_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
                  FIRST_SEEN, LAST_SEEN
           FROM performance_schema.events_statements_summary_by_digest
           ORDER BY SUM_TIMER_WAIT DESC
           LIMIT 20`,
        );
        return result;
      });
      return {
        rows: rows.map((row) => ({
          digest: str(row.DIGEST),
          digestText: str(row.DIGEST_TEXT).slice(0, 1_500),
          schemaName: row.SCHEMA_NAME == null ? null : str(row.SCHEMA_NAME),
          count: num(row.COUNT_STAR),
          avgLatencyMs: num(row.AVG_TIMER_WAIT) / 1e9,
          maxLatencyMs: num(row.MAX_TIMER_WAIT) / 1e9,
          rowsExamined: num(row.SUM_ROWS_EXAMINED),
          rowsSent: num(row.SUM_ROWS_SENT),
          firstSeen: row.FIRST_SEEN == null ? null : String(row.FIRST_SEEN),
          lastSeen: row.LAST_SEEN == null ? null : String(row.LAST_SEEN),
        })),
        source: 'performance_schema',
        advice: null,
      };
    } catch {
      // Fall through to the slow log.
    }
  }

  const slowLogOn = str(variables.slow_query_log).toUpperCase() === 'ON';
  const slowLogFile = str(variables.slow_query_log_file);
  if (slowLogOn && slowLogFile) {
    try {
      const rows = await readSlowLog(slowLogFile, str(variables.datadir));
      return { rows, source: 'slow_log', advice: null };
    } catch (error) {
      return {
        rows: [],
        source: 'none',
        advice: `The slow query log is enabled but could not be read: ${(error as Error).message}`,
      };
    }
  }

  return {
    rows: [],
    source: 'none',
    advice:
      'Performance Schema and the slow query log are both unavailable. Enable the slow log with: SET GLOBAL slow_query_log = ON; SET GLOBAL long_query_time = 1; (Performance Schema requires a server restart with performance_schema=ON.)',
  };
}

async function getReplication(
  profileId: string,
  command: 'SHOW REPLICA STATUS' | 'SHOW SLAVE STATUS',
): Promise<ReplicationStatus> {
  try {
    const rows = await withConnection(profileId, async (conn) => {
      const [result] = await conn.query<Row[]>(command);
      return result;
    });
    if (rows.length === 0) {
      return { configured: false, ioRunning: null, sqlRunning: null, lagSeconds: null };
    }
    const row = rows[0];
    return {
      configured: true,
      ioRunning: str(row.Replica_IO_Running ?? row.Slave_IO_Running) || null,
      sqlRunning: str(row.Replica_SQL_Running ?? row.Slave_SQL_Running) || null,
      lagSeconds:
        row.Seconds_Behind_Source != null
          ? num(row.Seconds_Behind_Source)
          : row.Seconds_Behind_Master != null
            ? num(row.Seconds_Behind_Master)
            : null,
    };
  } catch {
    return { configured: false, ioRunning: null, sqlRunning: null, lagSeconds: null };
  }
}

export async function getPerformanceSnapshot(profileId: string): Promise<PerformanceSnapshot> {
  const server = getCachedServerInfo(profileId) ?? (await connectProfile(profileId));
  const [status, variables, processlist, topTables] = await Promise.all([
    getGlobalStatus(profileId),
    getGlobalVariables(profileId),
    getProcessList(profileId),
    getTopTables(profileId, 10),
  ]);
  const slow = await getSlowQueries(
    profileId,
    server.capabilities.performanceSchema,
    variables,
  );
  const replication = await getReplication(profileId, server.capabilities.replicaStatusCommand);

  return {
    metrics: computeMetrics(status),
    status,
    variables,
    processlist,
    slowQueries: slow.rows,
    slowQuerySource: slow.source,
    slowQueryAdvice: slow.advice,
    replication,
    topTables,
    generatedAt: new Date().toISOString(),
  };
}

export async function killProcess(profileId: string, processId: number): Promise<void> {
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new Error('Invalid process id.');
  }
  await withConnection(profileId, async (conn) => {
    await conn.query('KILL ?', [processId]);
  });
}
