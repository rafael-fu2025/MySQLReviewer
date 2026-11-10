import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import type {
  PerformanceMetrics,
  PerformanceSnapshot,
  ProcessInfo,
  ReplicationStatus,
  ServerInfo,
  SlowQueryInfo,
  SqlFlavor,
  TableIoHotspots,
  TableIoInfo,
} from '../../shared/types';
import { getCachedServerInfo, connectProfile, withConnection } from './manager';
import { getTopTables } from './introspection';
import { parseVersion } from './dialect';
import { assertProcessInScope, getDatabaseScope } from './scope';
import { AppError } from '../errors';

export interface Row extends RowDataPacket {
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
      out[str(row.Variable_name)] = row.Value == null ? 'NULL' : String(row.Value);
    }
    // SHOW VARIABLES reports NULL as an empty string on some MariaDB builds.
    // Read the two security-sensitive values directly to preserve NULL.
    try {
      const [special] = await conn.query<Row[]>(
        'SELECT @@secure_file_priv AS secure_file_priv, @@bind_address AS bind_address',
      );
      if (special[0]) {
        out.secure_file_priv =
          special[0].secure_file_priv == null ? 'NULL' : String(special[0].secure_file_priv);
        out.bind_address =
          special[0].bind_address == null ? 'NULL' : String(special[0].bind_address);
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

export interface QpsSample {
  questions: number;
  at: number;
}

/** Last `Questions` counter reading per profile, used for delta-based QPS. */
const qpsSamples = new Map<string, QpsSample>();

/**
 * Questions per second between two counter readings. A counter reset (or any
 * non-positive delta) is reported as 0 rather than a negative rate.
 */
export function computeDeltaQps(
  previous: QpsSample | null | undefined,
  current: QpsSample,
): number {
  if (!previous) return 0;
  const elapsedMs = current.at - previous.at;
  if (!(elapsedMs > 0)) return 0;
  const delta = current.questions - previous.questions;
  if (!(delta > 0)) return 0;
  return delta / (elapsedMs / 1000);
}

function sampleQps(profileId: string, questions: number, at: number): number {
  const previous = qpsSamples.get(profileId);
  qpsSamples.set(profileId, { questions, at });
  return computeDeltaQps(previous, { questions, at });
}

export function computeMetrics(
  status: Record<string, string>,
  profileId?: string,
  at = Date.now(),
): PerformanceMetrics {
  const n = (key: string): number => num(status[key]);
  const uptimeSeconds = n('Uptime');
  const questions = n('Questions');
  const readRequests = n('Innodb_buffer_pool_read_requests');
  const physicalReads = n('Innodb_buffer_pool_reads');
  return {
    uptimeSeconds,
    qps: profileId ? sampleQps(profileId, questions, at) : 0,
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

/**
 * Resolve a server-reported `slow_query_log_file` inside `datadir`.
 * Absolute paths, UNC/drive paths, and anything that escapes the data directory
 * resolve to `null` so the file is never read.
 */
export function resolveSlowLogPath(file: string, datadir: string): string | null {
  const raw = file.trim();
  const base = datadir.trim();
  if (!raw || !base) return null;
  if (raw.includes('\0') || base.includes('\0')) return null;
  // Check both flavors so a POSIX absolute path cannot slip through on Windows
  // (and vice versa).
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) {
    return null;
  }
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, raw);
  const relative = path.relative(resolvedBase, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

/** One slow-log entry: the lines from a `# User@Host:` line to the next. */
interface SlowLogEntry {
  /** The `# Time:` value that preceded this entry, when the server printed one. */
  time: string | null;
  body: string[];
}

/**
 * Split a slow log into entries.
 *
 * Entries are delimited by `# User@Host:` lines, not by `# Time:` lines:
 * MariaDB omits `# Time:` when it repeats the previous entry's second, so a
 * split on `# Time:` would merge consecutive same-second queries into one
 * entry. A `# Time:` line always precedes its `# User@Host:` line, so it is
 * remembered as the pending time of the entry that follows; the server-start
 * headers before the first `# User@Host:` are dropped.
 */
function splitSlowLogEntries(text: string): SlowLogEntry[] {
  const entries: SlowLogEntry[] = [];
  let pendingTime: string | null = null;
  let currentTime: string | null = null;
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const timeLine = line.match(/^# Time:\s*(.*)$/);
    if (timeLine) {
      pendingTime = timeLine[1].trim().length > 0 ? timeLine[1].trim() : null;
      continue;
    }
    if (/^# User@Host:/.test(line)) {
      if (current) entries.push({ time: currentTime, body: current });
      current = [line];
      // The `# Time:` seen just before this line belongs to this entry.
      currentTime = pendingTime;
      pendingTime = null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) entries.push({ time: currentTime, body: current });
  return entries;
}

/** The timestamp of one entry, from `# Time:`, `SET timestamp=N;` or the last known time. */
function slowLogTimestamp(entry: SlowLogEntry, lastKnown: string | null): string | null {
  if (entry.time) return entry.time;
  // Both servers write `SET timestamp=N;` ahead of the statement; it is the
  // only timestamp an entry without `# Time:` carries of its own.
  const setMatch = entry.body.join('\n').match(/SET timestamp=(\d+)/i);
  if (setMatch) return new Date(Number(setMatch[1]) * 1000).toISOString();
  return lastKnown;
}

/**
 * Parse the text of a slow query log into the top slow statements.
 *
 * Consecutive entries of the same statement are grouped and capped the same
 * way the digest table reports them.
 */
export function parseSlowLogText(text: string): SlowQueryInfo[] {
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

  let lastTimestamp: string | null = null;
  for (const entry of splitSlowLogEntries(text)) {
    const block = entry.body.join('\n');
    const queryTime = block.match(/Query_time:\s*([0-9.]+)/);
    if (!queryTime) continue;
    const rowsSent = block.match(/Rows_sent:\s*(\d+)/);
    const rowsExamined = block.match(/Rows_examined:\s*(\d+)/);
    const timestamp = slowLogTimestamp(entry, lastTimestamp);
    if (timestamp) lastTimestamp = timestamp;
    const sqlMatch = block.match(
      /(?:^|\n)(?:use\s+[^;]+;\s*)?(SELECT[\s\S]*?|INSERT[\s\S]*?|UPDATE[\s\S]*?|DELETE[\s\S]*?|REPLACE[\s\S]*?|ALTER[\s\S]*?|CREATE[\s\S]*?|DROP[\s\S]*?);?\s*$/i,
    );
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
      digest: crypto.createHash('sha256').update(item.normalized).digest('hex').slice(0, 16),
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
}

async function readSlowLog(file: string, datadir: string): Promise<SlowQueryInfo[]> {
  const resolved = resolveSlowLogPath(file, datadir);
  if (!resolved) {
    throw new AppError(
      'SLOW_LOG_PATH_REJECTED',
      'The slow query log path is outside the server data directory, so it was not read.',
      400,
    );
  }
  const stat = await fs.stat(resolved);
  const maxTail = 4 * 1024 * 1024;
  const start = Math.max(0, stat.size - maxTail);
  const handle = await fs.open(resolved, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return parseSlowLogText(buffer.toString('utf8'));
  } finally {
    await handle.close();
  }
}

/** True when the server `version` string is at least `major.minor.patch`. */
export function atLeastVersion(
  version: string,
  major: number,
  minor: number,
  patch: number,
): boolean {
  const parts = parseVersion(version);
  if (parts.major !== major) return parts.major > major;
  if (parts.minor !== minor) return parts.minor > minor;
  return parts.patch >= patch;
}

/**
 * Whether `events_statements_summary_by_digest` carries the scan and temp
 * table columns. MySQL has had them since 5.6.5; MariaDB shipped the digest
 * table in 10.1.2 with the same columns.
 */
export function digestScanColumnsAvailable(flavor: SqlFlavor, version: string): boolean {
  return flavor === 'mysql' ? atLeastVersion(version, 5, 6, 5) : atLeastVersion(version, 10, 1, 2);
}

/**
 * `QUANTILE_95` / `QUANTILE_99` arrived in MySQL 8.0.19 and were never added
 * to MariaDB's digest table, so selecting them anywhere else errors out.
 */
export function digestQuantileColumnsAvailable(flavor: SqlFlavor, version: string): boolean {
  return flavor === 'mysql' && atLeastVersion(version, 8, 0, 19);
}

/**
 * The digest SELECT. The optional column groups are version-gated so a server
 * that predates them does not fail the whole query on an unknown column.
 */
export function buildDigestQuery(scanColumns: boolean, quantileColumns: boolean): string {
  const extra: string[] = [];
  if (scanColumns) {
    extra.push(
      'SUM_NO_INDEX_USED, SUM_NO_GOOD_INDEX_USED, SUM_CREATED_TMP_TABLES, SUM_CREATED_TMP_DISK_TABLES',
    );
  }
  if (quantileColumns) extra.push('QUANTILE_95, QUANTILE_99');
  return `SELECT SCHEMA_NAME, DIGEST, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT,
         AVG_TIMER_WAIT, MAX_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
         FIRST_SEEN, LAST_SEEN${extra.length > 0 ? `,${extra.join(',')}` : ''}
  FROM performance_schema.events_statements_summary_by_digest
  ORDER BY SUM_TIMER_WAIT DESC
  LIMIT 20`;
}

/** Map one digest-summary row to `SlowQueryInfo`; columns the SELECT skipped stay undefined. */
export function shapeDigestRow(row: Row): SlowQueryInfo {
  return {
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
    noIndexUsed: row.SUM_NO_INDEX_USED == null ? undefined : num(row.SUM_NO_INDEX_USED),
    noGoodIndexUsed:
      row.SUM_NO_GOOD_INDEX_USED == null ? undefined : num(row.SUM_NO_GOOD_INDEX_USED),
    tmpTables: row.SUM_CREATED_TMP_TABLES == null ? undefined : num(row.SUM_CREATED_TMP_TABLES),
    tmpDiskTables:
      row.SUM_CREATED_TMP_DISK_TABLES == null ? undefined : num(row.SUM_CREATED_TMP_DISK_TABLES),
    quantile95Ms: row.QUANTILE_95 == null ? undefined : num(row.QUANTILE_95) / 1e9,
    quantile99Ms: row.QUANTILE_99 == null ? undefined : num(row.QUANTILE_99) / 1e9,
  };
}

/**
 * Top slow statements by digest, from Performance Schema when available and
 * the slow query log otherwise. Exported for the agent's `slow_queries` tool;
 * `getPerformanceSnapshot` embeds the same result. Pass `server` (the resolved
 * `ServerInfo`) to enable the version-gated enrichment columns.
 */
export async function getSlowQueries(
  profileId: string,
  performanceSchema: boolean,
  variables: Record<string, string>,
  server?: { flavor: SqlFlavor; version: string },
): Promise<{
  rows: SlowQueryInfo[];
  source: 'performance_schema' | 'slow_log' | 'none';
  advice: string | null;
}> {
  if (performanceSchema) {
    const scanColumns = server ? digestScanColumnsAvailable(server.flavor, server.version) : false;
    const quantileColumns = server
      ? digestQuantileColumnsAvailable(server.flavor, server.version)
      : false;
    const readDigest = async (sql: string): Promise<SlowQueryInfo[]> =>
      withConnection(profileId, async (conn) => {
        const [result] = await conn.query<Row[]>(sql);
        return result.map(shapeDigestRow);
      });

    let rows: SlowQueryInfo[] | null = null;
    try {
      rows = await readDigest(buildDigestQuery(scanColumns, quantileColumns));
    } catch {
      // A version string that mispredicts the columns still fails the whole
      // query on an unknown column; retry with the base column set first.
    }
    if (rows == null && (scanColumns || quantileColumns)) {
      try {
        rows = await readDigest(buildDigestQuery(false, false));
      } catch {
        // Fall through to the slow log.
      }
    }
    if (rows != null) {
      return { rows, source: 'performance_schema', advice: null };
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

/* ------------------------------------------------------------------ */
/* Table I/O hotspots                                                  */
/* ------------------------------------------------------------------ */

/**
 * Shape the raw `table_io_waits_summary_by_table` rows. Timers are
 * picoseconds, like the digest table, so the same 1e9 conversion applies.
 */
export function shapeTableIoRows(rows: Row[]): TableIoInfo[] {
  return rows.map((row) => ({
    database: str(row.TABLE_SCHEMA),
    table: str(row.TABLE_NAME),
    countStar: num(row.COUNT_STAR),
    countRead: num(row.COUNT_READ),
    countWrite: num(row.COUNT_WRITE),
    totalLatencyMs: num(row.SUM_TIMER_WAIT) / 1e9,
  }));
}

/** Top tables by total I/O wait since server start. The limit is static and bounded. */
export function buildTableIoQuery(limit: number): string {
  const capped = Math.max(1, Math.min(50, Math.trunc(limit)));
  return `SELECT TABLE_SCHEMA, TABLE_NAME, COUNT_STAR, COUNT_READ, COUNT_WRITE, SUM_TIMER_WAIT
  FROM performance_schema.table_io_waits_summary_by_table
  WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
    AND COUNT_STAR > 0
  ORDER BY SUM_TIMER_WAIT DESC
  LIMIT ${capped}`;
}

const TABLE_IO_UNAVAILABLE =
  'performance_schema is disabled on this server, so table I/O statistics are unavailable. ' +
  'Restart the server with performance_schema=ON to enable them.';

/**
 * The most-read/written tables since server start. Degrades to an empty list
 * plus a reason when performance_schema is off or the rows cannot be read.
 */
export async function getTableIoHotspots(
  profileId: string,
  server?: ServerInfo,
): Promise<TableIoHotspots> {
  const info = server ?? getCachedServerInfo(profileId) ?? (await connectProfile(profileId));
  if (!info.capabilities.performanceSchema) {
    return { tables: [], reason: TABLE_IO_UNAVAILABLE };
  }
  try {
    const rows = await withConnection(profileId, async (conn) => {
      const [result] = await conn.query<Row[]>(buildTableIoQuery(10));
      return result;
    });
    return { tables: shapeTableIoRows(rows), reason: null };
  } catch (error) {
    return {
      tables: [],
      reason: `Table I/O statistics could not be read: ${(error as Error).message}`,
    };
  }
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

export async function getPerformanceSnapshot(
  profileId: string,
  override?: { allowed: string[] },
): Promise<PerformanceSnapshot> {
  const server = getCachedServerInfo(profileId) ?? (await connectProfile(profileId));
  const [status, variables, processlist, topTables, tableIo] = await Promise.all([
    getGlobalStatus(profileId),
    getGlobalVariables(profileId),
    getProcessList(profileId),
    getTopTables(profileId, 10, override),
    getTableIoHotspots(profileId, server),
  ]);
  const slow = await getSlowQueries(
    profileId,
    server.capabilities.performanceSchema,
    variables,
    server,
  );
  const replication = await getReplication(profileId, server.capabilities.replicaStatusCommand);

  return {
    metrics: computeMetrics(status, profileId),
    status,
    variables,
    processlist,
    slowQueries: slow.rows,
    slowQuerySource: slow.source,
    slowQueryAdvice: slow.advice,
    replication,
    topTables,
    tableIo: tableIo.tables,
    tableIoReason: tableIo.reason,
    generatedAt: new Date().toISOString(),
  };
}

export async function killProcess(
  profileId: string,
  processId: number,
  scopeOverride?: { allowed: string[] },
): Promise<void> {
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new AppError('VALIDATION', 'Invalid process id.', 400);
  }
  const [processlist, scope] = await Promise.all([
    getProcessList(profileId),
    getDatabaseScope(profileId, scopeOverride),
  ]);
  // Never KILL a pid that is not visible in the current processlist, or that
  // belongs to a database outside this connection's scope.
  assertProcessInScope(processId, processlist, scope);
  await withConnection(profileId, async (conn) => {
    await conn.query('KILL ?', [processId]);
  });
}
