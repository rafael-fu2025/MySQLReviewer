import crypto from 'node:crypto';
import type {
  AiProvider,
  AiReview,
  AuditEnvironment,
  AuditReport,
  AuditStats,
  AuditStep,
  CoverageItem,
  DatabaseObjects,
  Finding,
  SchemaSnapshot,
  ServerInfo,
} from '../../shared/types';
import { SYSTEM_SCHEMAS } from '../../shared/types';
import { AppError } from '../errors';
import { getProfile } from '../store/profiles';
import { saveReport } from '../store/reports';
import {
  getDatabaseObjects,
  getSchemaSnapshot,
} from '../db/introspection';
import {
  getGlobalStatus,
  getGlobalVariables,
  getPerformanceSnapshot,
} from '../db/metrics';
import { collectSecurityData } from '../db/security-audit';
import { withConnection } from '../db/manager';
import { getDatabaseScope } from '../db/scope';
import {
  runConfigRules,
  runPerformanceRules,
  runSchemaRules,
  runSecurityRules,
} from './rules';
import { dedupeFindings, groupFindings } from './findings';
import { scoreFindings } from './scoring';
import { runAuditSummary } from '../ai/analyze';

export interface AuditRunInput {
  profileId: string;
  databases: string[];
  server: ServerInfo;
  ai?: {
    provider: AiProvider;
    apiKey: string | null;
    onDelta: (text: string) => void;
    signal?: AbortSignal;
  };
  onProgress?: (event: {
    step?: AuditStep;
    percent?: number;
    message?: string;
  }) => void;
}

interface UnusedIndexesResult {
  findings: Finding[];
  coverage: CoverageItem;
}

async function loadUnusedIndexes(
  profileId: string,
  server: ServerInfo,
): Promise<UnusedIndexesResult> {
  if (server.capabilities.sysSchema) {
    try {
      const rows = await withConnection(profileId, async (conn) => {
        const [result] = await conn.query(
          `SELECT object_schema, object_name, index_name
           FROM sys.schema_unused_indexes
           WHERE object_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')`,
        );
        return result as Record<string, unknown>[];
      });
      const findings: Finding[] = rows.map((row) => ({
        id: crypto.randomUUID(),
        ruleId: 'schema.unused-index',
        title: 'Index has not been used since statistics reset',
        severity: 'low',
        category: 'performance',
        message: `Index \`${String(row.index_name)}\` on \`${String(row.object_schema)}.${String(row.object_name)}\` has zero recorded reads.`,
        recommendation:
          'Confirm the statistics window, then consider dropping the index. Verify no reporting query or constraint depends on it.',
        line: null,
        column: null,
        object: {
          database: String(row.object_schema),
          table: String(row.object_name),
          index: String(row.index_name),
        },
        source: 'rule',
        confidence: 'medium',
      }));
      return {
        findings,
        coverage: { check: 'Unused indexes', status: 'ran', count: rows.length },
      };
    } catch {
      // Fall through to performance_schema.
    }
  }

  if (server.capabilities.performanceSchema) {
    try {
      const rows = await withConnection(profileId, async (conn) => {
        const [result] = await conn.query(
          `SELECT OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME
           FROM performance_schema.table_io_waits_summary_by_index_usage
           WHERE INDEX_NAME IS NOT NULL
             AND INDEX_NAME <> 'PRIMARY'
             AND COUNT_STAR = 0
             AND OBJECT_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')`,
        );
        return result as Record<string, unknown>[];
      });
      const findings: Finding[] = rows.map((row) => ({
        id: crypto.randomUUID(),
        ruleId: 'schema.unused-index',
        title: 'Index has not been used since statistics reset',
        severity: 'low',
        category: 'performance',
        message: `Index \`${String(row.INDEX_NAME)}\` on \`${String(row.OBJECT_SCHEMA)}.${String(row.OBJECT_NAME)}\` has zero recorded reads.`,
        recommendation:
          'Confirm the statistics window, then consider dropping the index. Verify no constraint or reporting query depends on it.',
        line: null,
        column: null,
        object: {
          database: String(row.OBJECT_SCHEMA),
          table: String(row.OBJECT_NAME),
          index: String(row.INDEX_NAME),
        },
        source: 'rule',
        confidence: 'medium',
      }));
      return {
        findings,
        coverage: { check: 'Unused indexes', status: 'ran', count: rows.length },
      };
    } catch {
      // Fall through to unsupported.
    }
  }

  return {
    findings: [],
    coverage: {
      check: 'Unused indexes',
      status: 'unsupported',
      reason:
        'Requires the sys schema or performance_schema. This server has neither enabled (or the user lacks access).',
    },
  };
}

function aiSummaryReview(
  provider: AiProvider,
  text: string,
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null,
  durationMs: number,
): AiReview {
  return {
    providerId: provider.id,
    providerName: provider.name,
    model: provider.model,
    verdict: 'unknown',
    score: null,
    summary: text.slice(0, 500),
    findings: [],
    rewrite: null,
    markdown: text,
    usage,
    durationMs,
  };
}

export async function runAudit(input: AuditRunInput): Promise<AuditReport> {
  const started = Date.now();
  const profile = await getProfile(input.profileId);
  const databases = Array.from(
    new Set(
      input.databases.filter(
        (database) => database && !SYSTEM_SCHEMAS.includes(database),
      ),
    ),
  );
  if (databases.length === 0) {
    databases.push(...input.databases.filter(Boolean));
  }

  const scope = await getDatabaseScope(input.profileId);
  if (scope.mode === 'selected') {
    const allowed = databases.filter((database) => scope.allowed.has(database));
    databases.length = 0;
    databases.push(...allowed);
  }
  if (databases.length === 0) {
    throw new AppError(
      'DATABASE_SCOPE_EMPTY',
      'None of the selected databases are in this connection’s allowed scope.',
      403,
    );
  }

  const steps: AuditStep[] = [
    { key: 'snapshot', label: 'Schema snapshot', status: 'pending' },
    { key: 'schema-rules', label: 'Schema rules', status: 'pending' },
    { key: 'security', label: 'Accounts & privileges', status: 'pending' },
    { key: 'config', label: 'Server configuration', status: 'pending' },
    { key: 'performance', label: 'Performance telemetry', status: 'pending' },
    ...(input.ai ? [{ key: 'ai', label: 'AI executive summary', status: 'pending' as const }] : []),
    { key: 'finalize', label: 'Scoring & report', status: 'pending' },
  ];
  const stepMap = new Map(steps.map((step) => [step.key, step]));

  const emit = (percent?: number, message?: string): void => {
    input.onProgress?.({
      percent,
      message,
      step: undefined,
    });
  };
  const startStep = (key: string): void => {
    const step = stepMap.get(key);
    if (!step) return;
    step.status = 'running';
    input.onProgress?.({ step: { ...step } });
  };
  const finishStep = (
    key: string,
    status: AuditStep['status'],
    detail?: string,
    durationMs?: number,
  ): void => {
    const step = stepMap.get(key);
    if (!step) return;
    step.status = status;
    step.detail = detail;
    step.durationMs = durationMs;
    input.onProgress?.({ step: { ...step } });
  };

  emit(2, 'Reading server variables and status.');
  const [variables, status] = await Promise.all([
    getGlobalVariables(input.profileId),
    getGlobalStatus(input.profileId),
  ]);

  startStep('snapshot');
  const snapshotStarted = Date.now();
  const snapshots: SchemaSnapshot[] = [];
  const objects: DatabaseObjects[] = [];
  const coverage: CoverageItem[] = [];
  const snapshotErrors: string[] = [];
  let successfulDatabases = 0;

  for (let i = 0; i < databases.length; i += 1) {
    const database = databases[i];
    emit(
      5 + Math.round(((i + 1) / Math.max(1, databases.length)) * 55),
      `Reading schema ${database} (${i + 1}/${databases.length}).`,
    );
    try {
      const snapshot = await getSchemaSnapshot(input.profileId, database, true);
      snapshots.push(snapshot);
      successfulDatabases += 1;
    } catch (error) {
      snapshotErrors.push(`${database}: ${(error as Error).message}`);
    }
    try {
      objects.push(await getDatabaseObjects(input.profileId, database));
    } catch {
      // Object lists are supplementary; a missing one should not fail the audit.
    }
  }

  coverage.push({
    check: 'Schema snapshot',
    status: successfulDatabases > 0 ? 'ran' : 'error',
    count: successfulDatabases,
    reason:
      snapshotErrors.length > 0
        ? `${snapshotErrors.length} database(s) could not be read: ${snapshotErrors.slice(0, 3).join('; ')}`
        : undefined,
  });
  for (const error of snapshotErrors.slice(0, 5)) {
    coverage.push({ check: 'Database read', status: 'error', reason: error });
  }
  finishStep(
    'snapshot',
    successfulDatabases > 0 ? 'done' : 'error',
    `${successfulDatabases}/${databases.length} databases read`,
    Date.now() - snapshotStarted,
  );

  const allTables = snapshots.flatMap((snapshot) => snapshot.tables);
  const serverCharset = variables.character_set_server ?? null;

  emit(64, 'Running schema rules.');
  startStep('schema-rules');
  const schemaStarted = Date.now();
  const schemaFindings = allTables.flatMap((table) =>
    runSchemaRules(table, { serverCharset }),
  );
  finishStep(
    'schema-rules',
    'done',
    `${allTables.length} tables · ${schemaFindings.length} findings`,
    Date.now() - schemaStarted,
  );

  emit(72, 'Auditing accounts, privileges, and definers.');
  startStep('security');
  const securityStarted = Date.now();
  let securityFindings: Finding[] = [];
  try {
    const securityData = await collectSecurityData(input.profileId, variables);
    securityFindings = runSecurityRules(securityData);
    coverage.push(...securityData.coverage);
    finishStep(
      'security',
      'done',
      `${securityData.users.length} accounts · ${securityFindings.length} findings`,
      Date.now() - securityStarted,
    );
  } catch (error) {
    coverage.push({
      check: 'Accounts & privileges',
      status: 'error',
      reason: (error as Error).message,
    });
    finishStep('security', 'error', (error as Error).message, Date.now() - securityStarted);
  }

  emit(79, 'Checking server configuration.');
  startStep('config');
  const configStarted = Date.now();
  const configFindings = runConfigRules(variables, input.server);
  coverage.push({ check: 'Server configuration', status: 'ran', count: configFindings.length });
  finishStep('config', 'done', `${configFindings.length} findings`, Date.now() - configStarted);

  emit(84, 'Reading performance telemetry.');
  startStep('performance');
  const performanceStarted = Date.now();
  let performanceFindings: Finding[] = [];
  try {
    const performance = await getPerformanceSnapshot(input.profileId);
    performanceFindings = runPerformanceRules({
      metrics: performance.metrics,
      variables: performance.variables,
      processlist: performance.processlist,
      slowQueries: performance.slowQueries,
      replication: performance.replication,
    });
    coverage.push({
      check: 'Performance counters',
      status: 'ran',
      count: performanceFindings.length,
    });
    coverage.push({
      check: 'Slow query analysis',
      status: performance.slowQuerySource === 'none' ? 'skipped' : 'ran',
      reason: performance.slowQueryAdvice ?? undefined,
      count: performance.slowQueries.length,
    });
    coverage.push({
      check: 'Replication status',
      status: 'ran',
      reason: performance.replication.configured
        ? `lag=${performance.replication.lagSeconds ?? 'n/a'}s`
        : 'No replica configured.',
    });
    finishStep(
      'performance',
      'done',
      `${performanceFindings.length} findings · slow source: ${performance.slowQuerySource}`,
      Date.now() - performanceStarted,
    );
  } catch (error) {
    coverage.push({
      check: 'Performance counters',
      status: 'error',
      reason: (error as Error).message,
    });
    finishStep('performance', 'error', (error as Error).message, Date.now() - performanceStarted);
  }

  emit(90, 'Checking index usage.');
  const unused = await loadUnusedIndexes(input.profileId, input.server);
  coverage.push(unused.coverage);

  const findings = dedupeFindings([
    ...schemaFindings,
    ...securityFindings,
    ...configFindings,
    ...performanceFindings,
    ...unused.findings,
  ]);
  const score = scoreFindings(findings);
  const groups = groupFindings(findings);

  const stats: AuditStats = {
    databases: databases.length,
    tables: allTables.length,
    views: objects.reduce((sum, item) => sum + item.views.length, 0),
    routines: objects.reduce((sum, item) => sum + item.routines.length, 0),
    triggers: objects.reduce((sum, item) => sum + item.triggers.length, 0),
    events: objects.reduce((sum, item) => sum + item.events.length, 0),
    columns: allTables.reduce((sum, table) => sum + table.columns.length, 0),
    indexes: allTables.reduce((sum, table) => sum + table.indexes.length, 0),
    totalRowsEstimate: allTables.reduce((sum, table) => sum + table.rowsEstimate, 0),
    totalBytes: allTables.reduce(
      (sum, table) => sum + table.dataBytes + table.indexBytes,
      0,
    ),
  };

  const environment: AuditEnvironment = {
    server_version: input.server.version,
    flavor: input.server.flavor,
    uptime_seconds: input.server.uptimeSeconds,
    sql_mode: variables.sql_mode ?? null,
    character_set_server: variables.character_set_server ?? null,
    collation_server: variables.collation_server ?? null,
    default_storage_engine: variables.default_storage_engine ?? null,
    innodb_buffer_pool_size: variables.innodb_buffer_pool_size ?? null,
    max_connections: variables.max_connections ?? null,
    slow_query_log: variables.slow_query_log ?? null,
    long_query_time: variables.long_query_time ?? null,
    performance_schema: variables.performance_schema ?? null,
    local_infile: variables.local_infile ?? null,
    secure_file_priv: variables.secure_file_priv ?? null,
    bind_address: variables.bind_address ?? null,
    log_bin: variables.log_bin ?? null,
    databases: databases.join(', '),
    schema_errors: snapshotErrors.length,
    questions: status.Questions ?? null,
    threads_connected: status.Threads_connected ?? null,
    threads_running: status.Threads_running ?? null,
  };

  let ai: AiReview | null = null;
  if (input.ai) {
    emit(93, 'Requesting AI executive summary.');
    startStep('ai');
    const aiStarted = Date.now();
    try {
      const result = await runAuditSummary(
        {
          databases,
          server: input.server,
          score,
          stats,
          environment,
          groups,
        },
        input.ai.provider,
        input.ai.apiKey,
        input.ai.onDelta,
        input.ai.signal,
      );
      ai = aiSummaryReview(
        input.ai.provider,
        result.text,
        result.usage,
        Date.now() - aiStarted,
      );
      finishStep('ai', 'done', `${result.text.length} characters`, Date.now() - aiStarted);
    } catch (error) {
      finishStep('ai', 'error', (error as Error).message, Date.now() - aiStarted);
    }
  }

  emit(97, 'Scoring and saving the report.');
  startStep('finalize');
  const report: AuditReport = {
    id: `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    kind: 'audit',
    title: `Audit · ${databases.join(', ')}`.slice(0, 180),
    createdAt: new Date().toISOString(),
    profile: {
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      user: profile.user,
    },
    databaseScope: databases,
    server: input.server,
    score,
    findingsTotal: findings.length,
    groups,
    coverage,
    environment,
    stats,
    ai,
    durationMs: Date.now() - started,
    steps,
  };
  await saveReport(report);
  finishStep('finalize', 'done', `${findings.length} findings`, 0);
  emit(100, 'Audit complete.');
  return report;
}
