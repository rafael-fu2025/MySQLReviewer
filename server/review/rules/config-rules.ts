import type { Finding, ServerInfo } from '../../../shared/types';
import { createFinding } from '../findings';

function value(variables: Record<string, string>, key: string): string {
  return variables[key] ?? '';
}

function isOn(raw: string): boolean {
  const normalized = raw.trim().toUpperCase();
  return normalized === 'ON' || normalized === '1' || normalized === 'TRUE';
}

function bytes(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function runConfigRules(
  variables: Record<string, string>,
  server: ServerInfo | null,
): Finding[] {
  const findings: Finding[] = [];
  const add = (
    ruleId: string,
    title: string,
    severity: Finding['severity'],
    category: Finding['category'],
    message: string,
    recommendation: string,
    evidence: string,
    docs?: string,
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
        docs,
        source: 'rule',
        confidence: 'high',
      }),
    );
  };

  if (isOn(value(variables, 'local_infile'))) {
    add(
      'config.local-infile-enabled',
      'LOCAL INFILE is enabled',
      'high',
      'security',
      'local_infile lets clients ask the server to read local files as part of LOAD DATA.',
      'Disable it unless you actively need server-side local file loading: SET GLOBAL local_infile = OFF.',
      'local_infile=ON',
    );
  }

  const secureFilePriv = variables.secure_file_priv;
  if (secureFilePriv === '') {
    add(
      'config.secure-file-priv-empty',
      'secure_file_priv is unrestricted',
      'high',
      'security',
      'An empty secure_file_priv allows file import/export anywhere the MySQL process can reach.',
      'Set secure_file_priv to a dedicated directory, or NULL to disable file I/O (requires restart).',
      'secure_file_priv=""',
    );
  } else if (secureFilePriv == null || secureFilePriv === 'NULL') {
    add(
      'config.secure-file-priv-null',
      'secure_file_priv is not configured',
      'medium',
      'security',
      'secure_file_priv is NULL. Depending on the server flavor this either disables file I/O or leaves it unrestricted.',
      'Verify the behavior on this server and keep FILE privilege limited to trusted accounts.',
      'secure_file_priv=NULL',
    );
  }

  const bindAddress = value(variables, 'bind_address');
  if (
    !bindAddress ||
    bindAddress === 'NULL' ||
    bindAddress === '0.0.0.0' ||
    bindAddress === '*'
  ) {
    add(
      'config.network-exposed',
      'MySQL listens on all interfaces',
      'medium',
      'security',
      'bind_address is unset or wildcard, so the server accepts connections from the network.',
      'For a local development server, bind to 127.0.0.1 and restrict the firewall.',
      `bind_address=${bindAddress || 'NULL'}`,
    );
  }

  const sqlMode = value(variables, 'sql_mode').toUpperCase();
  if (!sqlMode.includes('STRICT_TRANS_TABLES') && !sqlMode.includes('STRICT_ALL_TABLES')) {
    add(
      'config.sql-mode-not-strict',
      'sql_mode is not strict',
      'high',
      'config',
      'Without STRICT_TRANS_TABLES, MySQL silently truncates or coerces invalid values instead of rejecting them.',
      'Add STRICT_TRANS_TABLES (and STRICT_ALL_TABLES where appropriate) to sql_mode after testing.',
      `sql_mode=${sqlMode || '(empty)'}`,
    );
  }
  if (!sqlMode.includes('ONLY_FULL_GROUP_BY')) {
    add(
      'config.only-full-group-by-off',
      'ONLY_FULL_GROUP_BY is disabled',
      'medium',
      'config',
      'GROUP BY queries may return arbitrary values for non-aggregated columns.',
      'Enable ONLY_FULL_GROUP_BY after fixing affected queries.',
      `sql_mode=${sqlMode || '(empty)'}`,
    );
  }

  if (!isOn(value(variables, 'slow_query_log'))) {
    add(
      'config.slow-query-log-off',
      'Slow query log is off',
      'medium',
      'config',
      'Slow statements are not recorded, which limits performance investigations.',
      'Enable it with: SET GLOBAL slow_query_log = ON; SET GLOBAL long_query_time = 1;',
      'slow_query_log=OFF',
    );
  }

  const longQueryTime = Number(value(variables, 'long_query_time'));
  if (Number.isFinite(longQueryTime) && longQueryTime > 2) {
    add(
      'config.long-query-time-high',
      'long_query_time is high',
      'low',
      'config',
      `Only queries slower than ${longQueryTime}s are logged.`,
      'Lower long_query_time to 1 second on development servers to surface more candidates.',
      `long_query_time=${longQueryTime}`,
    );
  }

  if (!isOn(value(variables, 'performance_schema'))) {
    add(
      'config.performance-schema-off',
      'Performance Schema is off',
      'low',
      'config',
      'Statement digests, index usage, and other runtime diagnostics are unavailable.',
      'Enable performance_schema=ON in my.ini and restart the server if you want statement-level diagnostics.',
      'performance_schema=OFF',
    );
  }

  if (bytes(value(variables, 'innodb_buffer_pool_size')) < 128 * 1024 * 1024) {
    add(
      'config.buffer-pool-small',
      'InnoDB buffer pool is small',
      'info',
      'config',
      `innodb_buffer_pool_size is ${Math.round(bytes(value(variables, 'innodb_buffer_pool_size')) / 1024 / 1024)} MB.`,
      'For a dedicated server, allocate a substantial fraction of RAM; for local XAMPP, a small pool may be expected.',
      `innodb_buffer_pool_size=${value(variables, 'innodb_buffer_pool_size')}`,
    );
  }

  if (value(variables, 'default_storage_engine').toUpperCase() !== 'INNODB') {
    add(
      'config.default-engine-not-innodb',
      'Default storage engine is not InnoDB',
      'high',
      'config',
      `New tables default to ${value(variables, 'default_storage_engine') || 'an unknown engine'}.`,
      'Set default_storage_engine=InnoDB to retain transactions, crash recovery, and foreign keys.',
      `default_storage_engine=${value(variables, 'default_storage_engine')}`,
    );
  }

  const serverCharset = value(variables, 'character_set_server').toLowerCase();
  if (['utf8', 'utf8mb3', 'latin1'].includes(serverCharset)) {
    add(
      'config.server-charset-narrow',
      'Server charset is not utf8mb4',
      'medium',
      'config',
      `character_set_server is ${serverCharset}.`,
      'Use utf8mb4 and a compatible collation to support the full Unicode range.',
      `character_set_server=${serverCharset}`,
    );
  }

  if (value(variables, 'innodb_flush_log_at_trx_commit') !== '1') {
    add(
      'config.flush-log-durability',
      'InnoDB durability is relaxed',
      'info',
      'config',
      `innodb_flush_log_at_trx_commit is ${value(variables, 'innodb_flush_log_at_trx_commit')}.`,
      'Use 1 when every committed transaction must survive a crash; lower values trade durability for speed.',
      `innodb_flush_log_at_trx_commit=${value(variables, 'innodb_flush_log_at_trx_commit')}`,
    );
  }

  if (!isOn(value(variables, 'log_bin'))) {
    add(
      'config.binary-log-off',
      'Binary logging is off',
      'info',
      'config',
      'Point-in-time recovery and replication are unavailable without the binary log.',
      'Enable log_bin if you need replication or point-in-time recovery.',
      'log_bin=OFF',
    );
  }

  if (Number(value(variables, 'max_connections')) > 0 && Number(value(variables, 'max_connections')) < 50) {
    add(
      'config.max-connections-low',
      'Low max_connections',
      'info',
      'config',
      `max_connections is ${value(variables, 'max_connections')}.`,
      'Confirm the value covers your connection pool plus administrative sessions.',
      `max_connections=${value(variables, 'max_connections')}`,
    );
  }

  if (!isOn(value(variables, 'skip_name_resolve'))) {
    add(
      'config.skip-name-resolve-off',
      'DNS reverse resolution is enabled',
      'info',
      'security',
      'Host name resolution can slow connections and make grants depend on DNS.',
      'Set skip_name_resolve=ON and use IP-based accounts.',
      'skip_name_resolve=OFF',
    );
  }

  if (server && server.flavor === 'mariadb' && server.sqlMode === '') {
    // The generic sql_mode check above already covers the risk; this note keeps the
    // MariaDB default visible without double-counting the finding.
  }

  return findings;
}
