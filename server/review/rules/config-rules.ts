import type { ServerInfo } from '../../../shared/types';
import { defineRule, runRules, type Rule } from './descriptor';

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

export interface ConfigRuleInput {
  variables: Record<string, string>;
  server: ServerInfo | null;
}

export const CONFIG_RULES: Rule<ConfigRuleInput>[] = [
  defineRule<ConfigRuleInput>(
    {
      id: 'config.local-infile-enabled',
      title: 'LOCAL INFILE is enabled',
      severity: 'high',
      category: 'security',
    },
    ({ variables }) =>
      isOn(value(variables, 'local_infile'))
        ? {
            message:
              'local_infile lets clients ask the server to read local files as part of LOAD DATA.',
            recommendation:
              'Disable it unless you actively need server-side local file loading: SET GLOBAL local_infile = OFF.',
            evidence: 'local_infile=ON',
          }
        : null,
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.secure-file-priv-empty',
      title: 'secure_file_priv is unrestricted',
      severity: 'high',
      category: 'security',
    },
    ({ variables }) =>
      variables.secure_file_priv === ''
        ? {
            message:
              'An empty secure_file_priv allows file import/export anywhere the MySQL process can reach.',
            recommendation:
              'Set secure_file_priv to a dedicated directory, or NULL to disable file I/O (requires restart).',
            evidence: 'secure_file_priv=""',
          }
        : null,
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.secure-file-priv-null',
      title: 'secure_file_priv is not configured',
      severity: 'medium',
      category: 'security',
    },
    ({ variables }) => {
      const secureFilePriv = variables.secure_file_priv;
      if (secureFilePriv == null || secureFilePriv === 'NULL') {
        return {
          message:
            'secure_file_priv is NULL. Depending on the server flavor this either disables file I/O or leaves it unrestricted.',
          recommendation:
            'Verify the behavior on this server and keep FILE privilege limited to trusted accounts.',
          evidence: 'secure_file_priv=NULL',
        };
      }
      return null;
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.network-exposed',
      title: 'MySQL listens on all interfaces',
      severity: 'medium',
      category: 'security',
    },
    ({ variables }) => {
      const bindAddress = value(variables, 'bind_address');
      if (
        bindAddress &&
        bindAddress !== 'NULL' &&
        bindAddress !== '0.0.0.0' &&
        bindAddress !== '*'
      ) {
        return null;
      }
      return {
        message:
          'bind_address is unset or wildcard, so the server accepts connections from the network.',
        recommendation:
          'For a local development server, bind to 127.0.0.1 and restrict the firewall.',
        evidence: `bind_address=${bindAddress || 'NULL'}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.sql-mode-not-strict',
      title: 'sql_mode is not strict',
      severity: 'high',
      category: 'config',
    },
    ({ variables }) => {
      const sqlMode = value(variables, 'sql_mode').toUpperCase();
      if (sqlMode.includes('STRICT_TRANS_TABLES') || sqlMode.includes('STRICT_ALL_TABLES')) {
        return null;
      }
      return {
        message:
          'Without STRICT_TRANS_TABLES, MySQL silently truncates or coerces invalid values instead of rejecting them.',
        recommendation:
          'Add STRICT_TRANS_TABLES (and STRICT_ALL_TABLES where appropriate) to sql_mode after testing.',
        evidence: `sql_mode=${sqlMode || '(empty)'}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.only-full-group-by-off',
      title: 'ONLY_FULL_GROUP_BY is disabled',
      severity: 'medium',
      category: 'config',
    },
    ({ variables }) => {
      const sqlMode = value(variables, 'sql_mode').toUpperCase();
      if (sqlMode.includes('ONLY_FULL_GROUP_BY')) return null;
      return {
        message: 'GROUP BY queries may return arbitrary values for non-aggregated columns.',
        recommendation: 'Enable ONLY_FULL_GROUP_BY after fixing affected queries.',
        evidence: `sql_mode=${sqlMode || '(empty)'}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.slow-query-log-off',
      title: 'Slow query log is off',
      severity: 'medium',
      category: 'config',
    },
    ({ variables }) =>
      isOn(value(variables, 'slow_query_log'))
        ? null
        : {
            message: 'Slow statements are not recorded, which limits performance investigations.',
            recommendation:
              'Enable it with: SET GLOBAL slow_query_log = ON; SET GLOBAL long_query_time = 1;',
            evidence: 'slow_query_log=OFF',
          },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.long-query-time-high',
      title: 'long_query_time is high',
      severity: 'low',
      category: 'config',
    },
    ({ variables }) => {
      const longQueryTime = Number(value(variables, 'long_query_time'));
      if (!Number.isFinite(longQueryTime) || longQueryTime <= 2) return null;
      return {
        message: `Only queries slower than ${longQueryTime}s are logged.`,
        recommendation:
          'Lower long_query_time to 1 second on development servers to surface more candidates.',
        evidence: `long_query_time=${longQueryTime}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.performance-schema-off',
      title: 'Performance Schema is off',
      severity: 'low',
      category: 'config',
    },
    ({ variables }) =>
      isOn(value(variables, 'performance_schema'))
        ? null
        : {
            message:
              'Statement digests, index usage, and other runtime diagnostics are unavailable.',
            recommendation:
              'Enable performance_schema=ON in my.ini and restart the server if you want statement-level diagnostics.',
            evidence: 'performance_schema=OFF',
          },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.buffer-pool-small',
      title: 'InnoDB buffer pool is small',
      severity: 'info',
      category: 'config',
    },
    ({ variables }) => {
      const size = bytes(value(variables, 'innodb_buffer_pool_size'));
      if (size >= 128 * 1024 * 1024) return null;
      return {
        message: `innodb_buffer_pool_size is ${Math.round(size / 1024 / 1024)} MB.`,
        recommendation:
          'For a dedicated server, allocate a substantial fraction of RAM; for local XAMPP, a small pool may be expected.',
        evidence: `innodb_buffer_pool_size=${value(variables, 'innodb_buffer_pool_size')}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.default-engine-not-innodb',
      title: 'Default storage engine is not InnoDB',
      severity: 'high',
      category: 'config',
    },
    ({ variables }) => {
      const engine = value(variables, 'default_storage_engine');
      if (engine.toUpperCase() === 'INNODB') return null;
      return {
        message: `New tables default to ${engine || 'an unknown engine'}.`,
        recommendation:
          'Set default_storage_engine=InnoDB to retain transactions, crash recovery, and foreign keys.',
        evidence: `default_storage_engine=${engine}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.server-charset-narrow',
      title: 'Server charset is not utf8mb4',
      severity: 'medium',
      category: 'config',
    },
    ({ variables }) => {
      const serverCharset = value(variables, 'character_set_server').toLowerCase();
      if (!['utf8', 'utf8mb3', 'latin1'].includes(serverCharset)) return null;
      return {
        message: `character_set_server is ${serverCharset}.`,
        recommendation: 'Use utf8mb4 and a compatible collation to support the full Unicode range.',
        evidence: `character_set_server=${serverCharset}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.flush-log-durability',
      title: 'InnoDB durability is relaxed',
      severity: 'info',
      category: 'config',
    },
    ({ variables }) => {
      const setting = value(variables, 'innodb_flush_log_at_trx_commit');
      if (setting === '1') return null;
      return {
        message: `innodb_flush_log_at_trx_commit is ${setting}.`,
        recommendation:
          'Use 1 when every committed transaction must survive a crash; lower values trade durability for speed.',
        evidence: `innodb_flush_log_at_trx_commit=${setting}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.binary-log-off',
      title: 'Binary logging is off',
      severity: 'info',
      category: 'config',
    },
    ({ variables }) =>
      isOn(value(variables, 'log_bin'))
        ? null
        : {
            message:
              'Point-in-time recovery and replication are unavailable without the binary log.',
            recommendation: 'Enable log_bin if you need replication or point-in-time recovery.',
            evidence: 'log_bin=OFF',
          },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.max-connections-low',
      title: 'Low max_connections',
      severity: 'info',
      category: 'config',
    },
    ({ variables }) => {
      const maxConnections = Number(value(variables, 'max_connections'));
      if (!(maxConnections > 0 && maxConnections < 50)) return null;
      return {
        message: `max_connections is ${maxConnections}.`,
        recommendation:
          'Confirm the value covers your connection pool plus administrative sessions.',
        evidence: `max_connections=${maxConnections}`,
      };
    },
  ),

  defineRule<ConfigRuleInput>(
    {
      id: 'config.skip-name-resolve-off',
      title: 'DNS reverse resolution is enabled',
      severity: 'info',
      category: 'security',
    },
    ({ variables }) =>
      isOn(value(variables, 'skip_name_resolve'))
        ? null
        : {
            message: 'Host name resolution can slow connections and make grants depend on DNS.',
            recommendation: 'Set skip_name_resolve=ON and use IP-based accounts.',
            evidence: 'skip_name_resolve=OFF',
          },
  ),
];

export function runConfigRules(
  variables: Record<string, string>,
  server: ServerInfo | null = null,
): ReturnType<typeof runRules<ConfigRuleInput>> {
  return runRules(CONFIG_RULES, { variables, server });
}
