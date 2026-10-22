import type {
  PerformanceMetrics,
  ProcessInfo,
  ReplicationStatus,
  SlowQueryInfo,
} from '../../../shared/types';
import { defineRule, runRules, type Rule } from './descriptor';

export interface PerformanceRuleInput {
  metrics: PerformanceMetrics;
  variables: Record<string, string>;
  processlist: ProcessInfo[];
  slowQueries: SlowQueryInfo[];
  replication: ReplicationStatus;
}

export const PERFORMANCE_RULES: Rule<PerformanceRuleInput>[] = [
  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.connections-near-limit',
      title: 'Connection usage is close to max_connections',
      severity: 'medium',
      category: 'performance',
    },
    ({ metrics, variables }) => {
      const maxConnections = Number(variables.max_connections ?? 0);
      if (!(maxConnections > 0 && metrics.threadsConnected / maxConnections > 0.8)) {
        return null;
      }
      return {
        message: `${metrics.threadsConnected} of ${maxConnections} connections are in use.`,
        recommendation:
          'Check for connection leaks or raise max_connections after reviewing memory usage.',
        evidence: `threads_connected=${metrics.threadsConnected} max_connections=${maxConnections}`,
      };
    },
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.many-running-threads',
      title: 'Many threads are running',
      severity: 'medium',
      category: 'performance',
    },
    ({ metrics }) =>
      metrics.threadsRunning > 20
        ? {
            message: `${metrics.threadsRunning} threads are actively executing statements.`,
            recommendation: 'Inspect the process list for long-running or blocked queries.',
            evidence: `threads_running=${metrics.threadsRunning}`,
          }
        : null,
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.aborted-connections',
      title: 'Many aborted connection attempts',
      severity: 'medium',
      category: 'performance',
    },
    ({ metrics }) =>
      metrics.abortedConnects > 100
        ? {
            message: `${metrics.abortedConnects.toLocaleString()} connection attempts were aborted since startup.`,
            recommendation: 'Check credentials, network stability, and connection pool timeouts.',
            evidence: `aborted_connects=${metrics.abortedConnects}`,
          }
        : null,
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.full-joins',
      title: 'Joins without indexes have occurred',
      severity: 'medium',
      category: 'performance',
    },
    ({ metrics }) =>
      metrics.selectFullJoin > 0
        ? {
            message: `${metrics.selectFullJoin.toLocaleString()} full joins have been executed since startup.`,
            recommendation: 'Inspect slow queries and add indexes for join columns.',
            evidence: `select_full_join=${metrics.selectFullJoin}`,
          }
        : null,
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.table-scans',
      title: 'High number of table scans',
      severity: 'low',
      category: 'performance',
    },
    ({ metrics }) =>
      metrics.selectScan > 1_000
        ? {
            message: `${metrics.selectScan.toLocaleString()} table scans have been recorded.`,
            recommendation:
              'Review the slow query log and add selective indexes for common predicates.',
            evidence: `select_scan=${metrics.selectScan}`,
          }
        : null,
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.temp-tables-spill',
      title: 'Temporary tables are spilling to disk',
      severity: 'medium',
      category: 'performance',
    },
    ({ metrics }) => {
      if (metrics.tmpTables <= 0) return null;
      const ratio = metrics.tmpDiskTables / metrics.tmpTables;
      if (!(ratio > 0.1)) return null;
      return {
        message: `${(ratio * 100).toFixed(1)}% of temporary tables were created on disk (${metrics.tmpDiskTables.toLocaleString()} of ${metrics.tmpTables.toLocaleString()}).`,
        recommendation:
          'Review GROUP BY/DISTINCT/UNION queries and increase tmp_table_size if appropriate.',
        evidence: `created_tmp_disk_tables=${metrics.tmpDiskTables} created_tmp_tables=${metrics.tmpTables}`,
      };
    },
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.buffer-pool-hit-low',
      title: 'Low InnoDB buffer pool hit ratio',
      severity: 'low',
      category: 'performance',
    },
    ({ metrics }) => {
      const ratio = metrics.bufferPoolHitRatio;
      if (ratio == null || ratio >= 0.95) return null;
      return {
        message: `The buffer pool hit ratio is ${(ratio * 100).toFixed(2)}%.`,
        recommendation: 'Increase innodb_buffer_pool_size or reduce the working set.',
        evidence: `hit_ratio=${(ratio * 100).toFixed(2)}%`,
      };
    },
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.deadlocks',
      title: 'InnoDB deadlocks have occurred',
      severity: 'medium',
      category: 'performance',
    },
    ({ metrics }) =>
      metrics.innodbDeadlocks > 0
        ? {
            message: `${metrics.innodbDeadlocks.toLocaleString()} deadlocks have been detected since startup.`,
            recommendation:
              'Inspect InnoDB deadlock details and keep transactions short with consistent lock ordering.',
            evidence: `innodb_deadlocks=${metrics.innodbDeadlocks}`,
          }
        : null,
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.table-locks-waited',
      title: 'Table lock waits have occurred',
      severity: 'info',
      category: 'performance',
    },
    ({ metrics }) =>
      metrics.tableLocksWaited > 0
        ? {
            message: `${metrics.tableLocksWaited.toLocaleString()} table lock waits were recorded.`,
            recommendation: 'Prefer InnoDB row-level locking and avoid long-lived table locks.',
            evidence: `table_locks_waited=${metrics.tableLocksWaited}`,
          }
        : null,
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.long-running-process',
      title: 'Long-running statement',
      severity: 'medium',
      category: 'performance',
    },
    ({ processlist }) => {
      const longRunning = processlist.filter(
        (process) =>
          process.command !== 'Sleep' && process.command !== 'Daemon' && process.timeSeconds >= 60,
      );
      if (longRunning.length === 0) return null;
      return longRunning.slice(0, 5).map((process) => ({
        message: `Session ${process.id} (${process.user}) has been running for ${process.timeSeconds}s in state ${process.state ?? 'unknown'}.`,
        recommendation:
          'Inspect the statement, check for locks, and consider killing it only after confirming the impact.',
        evidence: (process.info ?? 'no statement text').slice(0, 300),
        severity: process.timeSeconds >= 300 ? ('high' as const) : ('medium' as const),
      }));
    },
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.idle-connections',
      title: 'Many long-lived idle connections',
      severity: 'low',
      category: 'performance',
    },
    ({ processlist }) => {
      const sleeping = processlist.filter(
        (process) => process.command === 'Sleep' && process.timeSeconds >= 600,
      );
      if (sleeping.length <= 5) return null;
      return {
        message: `${sleeping.length} sessions have been sleeping for over 10 minutes.`,
        recommendation: 'Check connection pool sizing and application connection leaks.',
        evidence: `idle_sessions=${sleeping.length}`,
      };
    },
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.replication-stopped',
      title: 'Replication thread is not running',
      severity: 'high',
      category: 'performance',
    },
    ({ replication }) => {
      if (!replication.configured) return null;
      const ioStopped = replication.ioRunning && replication.ioRunning !== 'Yes';
      const sqlStopped = replication.sqlRunning && replication.sqlRunning !== 'Yes';
      if (!ioStopped && !sqlStopped) return null;
      return {
        message: `Replica IO=${replication.ioRunning ?? 'n/a'}, SQL=${replication.sqlRunning ?? 'n/a'}.`,
        recommendation: 'Check the replica error log and resolve the replication error.',
        evidence: `io=${replication.ioRunning} sql=${replication.sqlRunning}`,
      };
    },
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.replication-lag',
      title: 'Replication lag is high',
      severity: 'high',
      category: 'performance',
    },
    ({ replication }) => {
      if (!replication.configured) return null;
      const lag = replication.lagSeconds;
      if (lag == null || lag <= 60) return null;
      return {
        message: `The replica is ${lag}s behind the source.`,
        recommendation:
          'Inspect replica load, single-threaded apply, and long transactions on the source.',
        evidence: `seconds_behind=${lag}`,
      };
    },
  ),

  defineRule<PerformanceRuleInput>(
    {
      id: 'perf.slow-query',
      title: 'Slow query digest',
      severity: 'medium',
      category: 'performance',
    },
    ({ slowQueries }) => {
      const hits = slowQueries
        .slice(0, 5)
        .filter((query) => query.maxLatencyMs >= 500)
        .map((query) => ({
          message: `A digest ran ${query.count.toLocaleString()}× with an average of ${query.avgLatencyMs.toFixed(1)} ms and a maximum of ${query.maxLatencyMs.toFixed(1)} ms.`,
          recommendation:
            'Open the statement in the workspace, inspect EXPLAIN, and add or adjust indexes.',
          evidence: query.digestText.slice(0, 500),
          severity: query.maxLatencyMs > 5_000 ? ('high' as const) : ('medium' as const),
        }));
      return hits.length > 0 ? hits : null;
    },
  ),
];

export function runPerformanceRules(input: PerformanceRuleInput) {
  return runRules(PERFORMANCE_RULES, input);
}
