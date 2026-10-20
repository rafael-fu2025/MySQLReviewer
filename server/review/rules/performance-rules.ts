import type {
  Finding,
  PerformanceMetrics,
  ProcessInfo,
  ReplicationStatus,
  SlowQueryInfo,
} from '../../../shared/types';
import { createFinding } from '../findings';

export interface PerformanceRuleInput {
  metrics: PerformanceMetrics;
  variables: Record<string, string>;
  processlist: ProcessInfo[];
  slowQueries: SlowQueryInfo[];
  replication: ReplicationStatus;
}

export function runPerformanceRules(input: PerformanceRuleInput): Finding[] {
  const findings: Finding[] = [];
  const { metrics, variables, processlist, slowQueries, replication } = input;

  const add = (
    ruleId: string,
    title: string,
    severity: Finding['severity'],
    category: Finding['category'],
    message: string,
    recommendation: string,
    evidence?: string,
  ): void => {
    findings.push(
      createFinding({
        ruleId,
        title,
        severity,
        category,
        message,
        recommendation,
        evidence,
        source: 'rule',
        confidence: 'high',
      }),
    );
  };

  const maxConnections = Number(variables.max_connections ?? 0);
  if (maxConnections > 0 && metrics.threadsConnected / maxConnections > 0.8) {
    add(
      'perf.connections-near-limit',
      'Connection usage is close to max_connections',
      'medium',
      'performance',
      `${metrics.threadsConnected} of ${maxConnections} connections are in use.`,
      'Check for connection leaks or raise max_connections after reviewing memory usage.',
      `threads_connected=${metrics.threadsConnected} max_connections=${maxConnections}`,
    );
  }

  if (metrics.threadsRunning > 20) {
    add(
      'perf.many-running-threads',
      'Many threads are running',
      'medium',
      'performance',
      `${metrics.threadsRunning} threads are actively executing statements.`,
      'Inspect the process list for long-running or blocked queries.',
      `threads_running=${metrics.threadsRunning}`,
    );
  }

  if (metrics.abortedConnects > 100) {
    add(
      'perf.aborted-connections',
      'Many aborted connection attempts',
      'medium',
      'performance',
      `${metrics.abortedConnects.toLocaleString()} connection attempts were aborted since startup.`,
      'Check credentials, network stability, and connection pool timeouts.',
      `aborted_connects=${metrics.abortedConnects}`,
    );
  }

  if (metrics.selectFullJoin > 0) {
    add(
      'perf.full-joins',
      'Joins without indexes have occurred',
      'medium',
      'performance',
      `${metrics.selectFullJoin.toLocaleString()} full joins have been executed since startup.`,
      'Inspect slow queries and add indexes for join columns.',
      `select_full_join=${metrics.selectFullJoin}`,
    );
  }

  if (metrics.selectScan > 1_000) {
    add(
      'perf.table-scans',
      'High number of table scans',
      'low',
      'performance',
      `${metrics.selectScan.toLocaleString()} table scans have been recorded.`,
      'Review the slow query log and add selective indexes for common predicates.',
      `select_scan=${metrics.selectScan}`,
    );
  }

  if (metrics.tmpTables > 0) {
    const ratio = metrics.tmpDiskTables / metrics.tmpTables;
    if (ratio > 0.1) {
      add(
        'perf.temp-tables-spill',
        'Temporary tables are spilling to disk',
        'medium',
        'performance',
        `${(ratio * 100).toFixed(1)}% of temporary tables were created on disk (${metrics.tmpDiskTables.toLocaleString()} of ${metrics.tmpTables.toLocaleString()}).`,
        'Review GROUP BY/DISTINCT/UNION queries and increase tmp_table_size if appropriate.',
        `created_tmp_disk_tables=${metrics.tmpDiskTables} created_tmp_tables=${metrics.tmpTables}`,
      );
    }
  }

  if (metrics.bufferPoolHitRatio != null && metrics.bufferPoolHitRatio < 0.95) {
    add(
      'perf.buffer-pool-hit-low',
      'Low InnoDB buffer pool hit ratio',
      'low',
      'performance',
      `The buffer pool hit ratio is ${(metrics.bufferPoolHitRatio * 100).toFixed(2)}%.`,
      'Increase innodb_buffer_pool_size or reduce the working set.',
      `hit_ratio=${(metrics.bufferPoolHitRatio * 100).toFixed(2)}%`,
    );
  }

  if (metrics.innodbDeadlocks > 0) {
    add(
      'perf.deadlocks',
      'InnoDB deadlocks have occurred',
      'medium',
      'performance',
      `${metrics.innodbDeadlocks.toLocaleString()} deadlocks have been detected since startup.`,
      'Inspect InnoDB deadlock details and keep transactions short with consistent lock ordering.',
      `innodb_deadlocks=${metrics.innodbDeadlocks}`,
    );
  }

  if (metrics.tableLocksWaited > 0) {
    add(
      'perf.table-locks-waited',
      'Table lock waits have occurred',
      'info',
      'performance',
      `${metrics.tableLocksWaited.toLocaleString()} table lock waits were recorded.`,
      'Prefer InnoDB row-level locking and avoid long-lived table locks.',
      `table_locks_waited=${metrics.tableLocksWaited}`,
    );
  }

  const longRunning = processlist.filter(
    (process) =>
      process.command !== 'Sleep' &&
      process.command !== 'Daemon' &&
      process.timeSeconds >= 60,
  );
  for (const process of longRunning.slice(0, 5)) {
    add(
      'perf.long-running-process',
      'Long-running statement',
      process.timeSeconds >= 300 ? 'high' : 'medium',
      'performance',
      `Session ${process.id} (${process.user}) has been running for ${process.timeSeconds}s in state ${process.state ?? 'unknown'}.`,
      'Inspect the statement, check for locks, and consider killing it only after confirming the impact.',
      (process.info ?? 'no statement text').slice(0, 300),
    );
  }

  const sleeping = processlist.filter(
    (process) => process.command === 'Sleep' && process.timeSeconds >= 600,
  );
  if (sleeping.length > 5) {
    add(
      'perf.idle-connections',
      'Many long-lived idle connections',
      'low',
      'performance',
      `${sleeping.length} sessions have been sleeping for over 10 minutes.`,
      'Check connection pool sizing and application connection leaks.',
      `idle_sessions=${sleeping.length}`,
    );
  }

  if (replication.configured) {
    if (
      (replication.ioRunning && replication.ioRunning !== 'Yes') ||
      (replication.sqlRunning && replication.sqlRunning !== 'Yes')
    ) {
      add(
        'perf.replication-stopped',
        'Replication thread is not running',
        'high',
        'performance',
        `Replica IO=${replication.ioRunning ?? 'n/a'}, SQL=${replication.sqlRunning ?? 'n/a'}.`,
        'Check the replica error log and resolve the replication error.',
        `io=${replication.ioRunning} sql=${replication.sqlRunning}`,
      );
    }
    if (replication.lagSeconds != null && replication.lagSeconds > 60) {
      add(
        'perf.replication-lag',
        'Replication lag is high',
        'high',
        'performance',
        `The replica is ${replication.lagSeconds}s behind the source.`,
        'Inspect replica load, single-threaded apply, and long transactions on the source.',
        `seconds_behind=${replication.lagSeconds}`,
      );
    }
  }

  for (const query of slowQueries.slice(0, 5)) {
    if (query.maxLatencyMs < 500) continue;
    add(
      'perf.slow-query',
      'Slow query digest',
      query.maxLatencyMs > 5_000 ? 'high' : 'medium',
      'performance',
      `A digest ran ${query.count.toLocaleString()}× with an average of ${query.avgLatencyMs.toFixed(1)} ms and a maximum of ${query.maxLatencyMs.toFixed(1)} ms.`,
      'Open the statement in the workspace, inspect EXPLAIN, and add or adjust indexes.',
      query.digestText.slice(0, 500),
    );
  }

  return findings;
}
