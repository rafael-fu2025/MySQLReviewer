/**
 * Characterization harness for the review rule engine.
 *
 * Runs every rule module over a fixed corpus and prints a normalized JSON
 * snapshot of the findings. Use it to prove that a refactor did not change
 * rule behavior:
 *
 *   npx tsx scripts/rule-snapshot.ts > before.json
 *   # ... refactor ...
 *   npx tsx scripts/rule-snapshot.ts > after.json
 *   diff before.json after.json
 *
 * Random finding ids are stripped and findings are sorted, so the output is
 * stable across runs.
 */
import type {
  ColumnInfo,
  DbUser,
  Finding,
  ForeignKeyInfo,
  IndexInfo,
  PerformanceMetrics,
  ProcessInfo,
  ReplicationStatus,
  SchemaSnapshot,
  SchemaTable,
  SlowQueryInfo,
} from '../shared/types';
import type { SecurityData } from '../server/db/security-audit';
import { buildRuleContext } from '../server/review/context';
import { dedupeFindings } from '../server/review/findings';
import {
  runConfigRules,
  runPerformanceRules,
  runQuerySchemaRules,
  runSchemaRules,
  runSecurityRules,
  runSqlRules,
} from '../server/review/rules';

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    position: 1,
    dataType: 'int',
    columnType: 'int(11)',
    nullable: false,
    defaultValue: null,
    extra: '',
    key: '',
    comment: '',
    charset: null,
    collation: null,
    generationExpression: null,
    ...overrides,
  };
}

function index(name: string, columns: string[], unique = false): IndexInfo {
  return {
    name,
    unique,
    type: 'BTREE',
    columns: columns.map((columnName) => ({ name: columnName, subPart: null, collation: 'A' })),
    cardinality: 1000,
    comment: '',
  };
}

function foreignKey(name: string, columns: string[], onDelete = 'RESTRICT'): ForeignKeyInfo {
  return {
    name,
    columns,
    referencedDatabase: 'shop',
    referencedTable: 'customers',
    referencedColumns: ['id'],
    onUpdate: 'RESTRICT',
    onDelete,
  } as ForeignKeyInfo;
}

function table(name: string, overrides: Partial<SchemaTable> = {}): SchemaTable {
  return {
    database: 'shop',
    name,
    type: 'BASE TABLE',
    engine: 'InnoDB',
    rowsEstimate: 1000,
    dataBytes: 16_384,
    indexBytes: 16_384,
    dataFreeBytes: 0,
    collation: 'utf8mb4_general_ci',
    charset: 'utf8mb4',
    comment: '',
    columns: [column('id', { key: 'PRI', extra: 'auto_increment' })],
    indexes: [index('PRIMARY', ['id'], true)],
    foreignKeys: [],
    ...overrides,
  };
}

/** Schema exercising the schema/query-schema rules. */
function buildSchema(): SchemaSnapshot {
  const orders = table('orders', {
    rowsEstimate: 250_000,
    dataBytes: 40 * 1024 * 1024,
    dataFreeBytes: 12 * 1024 * 1024,
    columns: [
      column('id', { position: 1, key: 'PRI', extra: 'auto_increment' }),
      column('customer_id', { position: 2 }),
      column('status', {
        position: 3,
        dataType: 'varchar',
        columnType: 'varchar(32)',
        nullable: true,
      }),
      column('total', { position: 4, dataType: 'decimal', columnType: 'decimal(10,2)' }),
      column('label', { position: 5, dataType: 'varchar', columnType: 'varchar(255)' }),
      column('created_at', { position: 6, dataType: 'datetime', columnType: 'datetime' }),
      column('notes', { position: 7, dataType: 'text', columnType: 'text' }),
      column('ratio', { position: 8, dataType: 'float', columnType: 'float' }),
      column('legacy', { position: 9, dataType: 'varchar', columnType: 'varchar(300)' }),
      column('code', { position: 10, dataType: 'varchar', columnType: 'varchar(64)' }),
      column('select', { position: 11, dataType: 'int' }),
      column('GROUP', { position: 12, dataType: 'int' }),
      column('price', { position: 13, dataType: 'float', columnType: 'float' }),
      column('huge', { position: 14, dataType: 'varchar', columnType: 'varchar(2000)' }),
      column('mixed_charset', {
        position: 15,
        dataType: 'varchar',
        columnType: 'varchar(64)',
        charset: 'latin1',
      }),
      column('tenant_id', { position: 16 }),
    ],
    indexes: [
      index('PRIMARY', ['id'], true),
      index('idx_status', ['status']),
      { ...index('idx_status_dup', ['status']), duplicateOf: 'idx_status' },
      { ...index('idx_label', ['label']), redundantOf: 'idx_multi_label' },
      index('idx_notes', ['notes']),
      index('idx_multi', ['customer_id', 'status']),
      index('idx_wide', ['id', 'status', 'label', 'code', 'total', 'ratio']),
    ],
    foreignKeys: [
      foreignKey('fk_orders_customer', ['customer_id']),
      foreignKey('fk_orders_tenant', ['tenant_id']),
    ],
  });

  const customers = table('customers', {
    columns: [
      column('id', { position: 1, key: 'PRI', extra: 'auto_increment' }),
      column('name', { position: 2, dataType: 'varchar', columnType: 'varchar(120)' }),
      column('email', {
        position: 3,
        dataType: 'varchar',
        columnType: 'varchar(255)',
        nullable: true,
      }),
    ],
  });

  const noKeys = table('no_keys', {
    engine: 'MyISAM',
    charset: 'latin1',
    collation: 'latin1_swedish_ci',
    columns: [
      column('a', { position: 1, dataType: 'int' }),
      column('b', { position: 2, dataType: 'varchar', columnType: 'varchar(255)' }),
    ],
    indexes: [],
  });

  const wide = table('wide', {
    rowsEstimate: 10,
    columns: Array.from({ length: 60 }, (_, i) =>
      column(`c${i}`, { position: i + 1, dataType: 'int' }),
    ),
    indexes: Array.from({ length: 12 }, (_, i) => index(`idx_${i}`, [`c${i}`])),
  });

  const mixedCase = table('MixedCase', {
    columns: [column('id', { position: 1, key: 'PRI', extra: 'auto_increment' })],
  });

  const reservedName = table('order', {
    columns: [column('id', { position: 1, key: 'PRI', extra: 'auto_increment' })],
  });

  const utf8mb3Table = table('legacy_utf8', {
    charset: 'utf8mb3',
    collation: 'utf8mb3_general_ci',
    columns: [column('id', { position: 1, key: 'PRI', extra: 'auto_increment' })],
  });

  const setNullFk = table('set_null_fk', {
    columns: [
      column('id', { position: 1, key: 'PRI', extra: 'auto_increment' }),
      column('parent_id', { position: 2, nullable: false }),
    ],
    indexes: [index('PRIMARY', ['id'], true), index('idx_parent', ['parent_id'])],
    foreignKeys: [foreignKey('fk_set_null', ['parent_id'], 'SET NULL')],
  });

  const nonAutoPk = table('non_auto_pk', {
    columns: [column('id', { position: 1, key: 'PRI' })],
    indexes: [index('PRIMARY', ['id'], true)],
  });

  const longName = table('a'.repeat(70), {
    columns: [column('id', { position: 1, key: 'PRI', extra: 'auto_increment' })],
  });

  return {
    database: 'shop',
    tables: [
      orders,
      customers,
      noKeys,
      wide,
      setNullFk,
      nonAutoPk,
      longName,
      mixedCase,
      reservedName,
      utf8mb3Table,
    ],
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };
}

const SQL_CORPUS: string[] = [
  'SELECT * FROM orders',
  'SELECT * FROM orders, customers',
  'SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id',
  'SELECT * FROM orders o CROSS JOIN customers c',
  'DELETE FROM orders',
  'DELETE FROM orders WHERE id = 1',
  'UPDATE orders SET status = "x"',
  'UPDATE orders SET status = "x" WHERE id = 1',
  'DROP TABLE orders',
  'TRUNCATE TABLE orders',
  'ALTER TABLE orders ADD COLUMN note TEXT',
  'USE shop',
  'SELECT id FROM orders WHERE id = NULL',
  'SELECT id FROM orders WHERE id != NULL',
  'SELECT id FROM orders WHERE id NOT IN (1, 2, 3)',
  'SELECT id FROM orders WHERE id NOT IN (SELECT id FROM customers)',
  'SELECT id FROM orders WHERE status = "paid" OR total > 10',
  'SELECT status, count(*) FROM orders GROUP BY status',
  'SELECT id, count(*) FROM orders GROUP BY status',
  'SELECT status FROM orders HAVING count(*) > 1',
  'SELECT id FROM orders ORDER BY RAND()',
  'SELECT id FROM orders LIMIT 5 OFFSET 5000',
  'SELECT id FROM orders LIMIT 2000000',
  'SELECT id FROM orders WHERE label LIKE "%bob%"',
  'SELECT id FROM orders WHERE label LIKE "bob%"',
  'SELECT id FROM orders WHERE notes LIKE "%x%"',
  'SELECT id FROM orders',
  'SELECT id FROM orders ORDER BY id',
  'SELECT DISTINCT status FROM orders',
  'SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers)',
  'INSERT INTO orders VALUES (1, 2, 3)',
  'INSERT INTO orders (id, status) VALUES (1, "x")',
  'REPLACE INTO orders (id, status) VALUES (1, "x")',
  'SELECT id FROM orders FOR UPDATE',
  'SELECT id FROM orders LOCK IN SHARE MODE',
  'SELECT id FROM orders FOR SHARE',
  'SELECT SQL_CALC_FOUND_ROWS id FROM orders',
  'SELECT id FROM orders WHERE label REGEXP "abc"',
  'SELECT id FROM orders INTO OUTFILE "/tmp/x.csv"',
  'SELECT id FROM orders UNION SELECT id FROM customers',
  'SELECT id FROM orders UNION ALL SELECT id FROM customers',
  'BEGIN; CREATE TABLE t (id INT);',
  'SELECT 1; DELETE FROM orders;',
  'SELECT id FROM orders WHERE total = 10',
  'SELECT id FROM orders WHERE total = "10"',
  'SELECT id FROM orders WHERE status = 5',
  'SELECT id FROM orders WHERE created_at = "2026-01-01"',
  'SELECT id FROM orders WHERE label LIKE "%x%"',
  'SELECT o.id FROM orders o JOIN customers c ON o.customer_id = c.id',
  'SELECT o.id FROM orders o LEFT JOIN customers c ON o.customer_id = c.id',
  'SELECT missing FROM orders',
  'SELECT id FROM orders o JOIN customers c ON o.customer_id = c.id',
  'SELECT id FROM orders WHERE customer_id = 1 AND notes = "x"',
  'SELECT COUNT(*) FROM orders WHERE id IN (1,2,3)',
  'SELECT id FROM orders WHERE id IN (SELECT customer_id FROM customers)',
  'SELECT UPPER(label) FROM orders WHERE id = 1',
  'SELECT id FROM no_keys',
  'SELECT id FROM customers',
  'SELECT o.id FROM orders o JOIN customers c ON o.code = c.id',
  'SELECT id FROM orders WHERE total LIKE "%x%"',
  'SELECT id FROM orders WHERE status NOT IN ("a", "b")',
  'DELETE FROM no_keys WHERE a = 1',
  'UPDATE no_keys SET a = 1 WHERE a = 2',
  'SELECT count(*) FROM orders ORDER BY status',
  'SELECT o.id FROM orders o JOIN customers c ON o.tenant_id = c.id',
  'SELECT c.id FROM customers c JOIN no_keys n ON c.id = n.a',
];

function buildUser(overrides: Partial<DbUser>): DbUser {
  return {
    user: 'app',
    host: 'localhost',
    plugin: 'caching_sha2_password',
    passwordSet: true,
    superPriv: false,
    filePriv: false,
    processPriv: false,
    grantPriv: false,
    shutdownPriv: false,
    createUserPriv: false,
    reloadPriv: false,
    ...overrides,
  };
}

function buildSecurityData(): SecurityData {
  const users: DbUser[] = [
    buildUser({ user: '', host: 'localhost' }),
    buildUser({ user: 'nopass', host: 'localhost', passwordSet: false }),
    buildUser({ user: 'root', host: '%' }),
    buildUser({ user: 'root', host: 'localhost' }),
    buildUser({ user: 'wild', host: '%', superPriv: true, filePriv: true }),
    buildUser({
      user: 'granter',
      host: 'localhost',
      grantPriv: true,
      processPriv: true,
      shutdownPriv: true,
      createUserPriv: true,
    }),
    buildUser({ user: 'legacy', host: 'localhost', plugin: 'mysql_old_password' }),
    buildUser({ user: 'native', host: 'localhost', plugin: 'mysql_native_password' }),
    buildUser({ user: 'socket', host: 'localhost', plugin: 'unix_socket', passwordSet: false }),
  ];
  return {
    users,
    privilegeSummaries: [
      {
        user: 'wild',
        host: '%',
        privileges: Array.from({ length: 25 }, (_, i) => `PRIV_${i}`),
        grantOption: true,
      },
    ],
    definers: ['`missing`@`localhost`', '`app`@`localhost`', '`nobody`@`%`'],
    config: {
      localInfile: 'ON',
      secureFilePriv: null,
      bindAddress: null,
      sqlMode: '',
      skipNameResolve: 'OFF',
    } as SecurityData['config'],
    coverage: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const CONFIG_VARIABLES: Record<string, string> = {
  local_infile: 'ON',
  secure_file_priv: '',
  bind_address: '0.0.0.0',
  sql_mode: 'NO_ENGINE_SUBSTITUTION',
  skip_name_resolve: 'OFF',
  slow_query_log: 'OFF',
  long_query_time: '10',
  performance_schema: 'OFF',
  max_connections: '30',
  innodb_buffer_pool_size: '67108864',
  character_set_server: 'latin1',
  binlog: 'OFF',
  sync_binlog: '0',
  innodb_flush_log_at_trx_commit: '0',
};

/** secure_file_priv explicitly set to the literal string NULL. */
const NULL_FILE_PRIV_VARIABLES: Record<string, string> = {
  ...CONFIG_VARIABLES,
  secure_file_priv: 'NULL',
};

const CLEAN_CONFIG_VARIABLES: Record<string, string> = {
  local_infile: 'OFF',
  secure_file_priv: '/var/lib/mysql-files',
  bind_address: '127.0.0.1',
  sql_mode: 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES',
  skip_name_resolve: 'ON',
  slow_query_log: 'ON',
  long_query_time: '1',
  performance_schema: 'ON',
  max_connections: '500',
  innodb_buffer_pool_size: '8589934592',
  character_set_server: 'utf8mb4',
  binlog: 'ON',
  sync_binlog: '1',
  innodb_flush_log_at_trx_commit: '1',
};

function buildMetrics(): PerformanceMetrics {
  return {
    uptimeSeconds: 86_400,
    qps: 120,
    threadsConnected: 28,
    threadsRunning: 25,
    maxUsedConnections: 30,
    abortedConnects: 150,
    abortedClients: 12,
    slowQueries: 40,
    selectScan: 5_000,
    selectFullJoin: 12,
    tmpDiskTables: 300,
    tmpTables: 1_000,
    bufferPoolHitRatio: 0.85,
    tableLocksWaited: 9,
    innodbDeadlocks: 3,
    bytesReceived: 1_000_000,
    bytesSent: 2_000_000,
    openTables: 400,
    queries: 1_000_000,
  };
}

const PROCESSLIST: ProcessInfo[] = [
  {
    id: 1,
    user: 'app',
    host: 'localhost',
    db: 'shop',
    command: 'Query',
    timeSeconds: 300,
    state: 'Sending data',
    info: 'SELECT * FROM orders',
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    id: i + 2,
    user: 'app',
    host: 'localhost',
    db: 'shop',
    command: 'Sleep',
    timeSeconds: 900,
    state: null,
    info: null,
  })),
];

const SLOW_QUERIES: SlowQueryInfo[] = [
  {
    digest: 'abc123',
    digestText: 'SELECT * FROM orders WHERE status = ?',
    schemaName: 'shop',
    count: 25,
    avgLatencyMs: 1_500,
    maxLatencyMs: 9_000,
    rowsExamined: 250_000,
    rowsSent: 10,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-02T00:00:00.000Z',
  },
];

const REPLICATION: ReplicationStatus = {
  configured: true,
  ioRunning: 'No',
  sqlRunning: 'No',
  lagSeconds: 120,
};

/** Strip non-deterministic fields so snapshots are comparable. */
function stripFinding(finding: Finding): Record<string, unknown> {
  return {
    ruleId: finding.ruleId,
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    message: finding.message,
    recommendation: finding.recommendation,
    evidence: finding.evidence ?? null,
    line: finding.line ?? null,
    column: finding.column ?? null,
    object: finding.object ?? null,
    docs: finding.docs ?? null,
    source: finding.source ?? null,
    confidence: finding.confidence ?? null,
  };
}

/** Order-insensitive canonical form. */
function normalize(findings: Finding[]): unknown[] {
  return findings.map(stripFinding).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Order-sensitive form: keeps emission order. */
function ordered(findings: Finding[]): unknown[] {
  return findings.map(stripFinding);
}

async function main(): Promise<void> {
  const schema = buildSchema();
  const output: Record<string, unknown> = {};

  const sqlFindings: unknown[] = [];
  for (const sql of SQL_CORPUS) {
    const context = buildRuleContext({
      sql,
      schema,
    });
    const raw: Finding[] = [...runSqlRules(context), ...runQuerySchemaRules(context)];
    sqlFindings.push({
      sql,
      // The exact array the product returns (runStaticReview dedupes + sorts).
      findings: ordered(dedupeFindings(raw)),
      // The full rule output, order-insensitive.
      all: normalize(raw),
    });
  }
  output.sql = sqlFindings;

  output.schema = normalize(
    schema.tables.flatMap((tbl) => runSchemaRules(tbl, { serverCharset: 'utf8mb4' })),
  );
  output.schemaOrdered = ordered(
    schema.tables.flatMap((tbl) => runSchemaRules(tbl, { serverCharset: 'utf8mb4' })),
  );

  output.schemaFinal = ordered(
    dedupeFindings(
      schema.tables.flatMap((tbl) => runSchemaRules(tbl, { serverCharset: 'utf8mb4' })) as never,
    ),
  );

  output.security = normalize(runSecurityRules(buildSecurityData()));
  output.securityOrdered = ordered(runSecurityRules(buildSecurityData()));

  output.config = normalize([
    ...runConfigRules(CONFIG_VARIABLES, null),
    ...runConfigRules(NULL_FILE_PRIV_VARIABLES, null),
    ...runConfigRules(CLEAN_CONFIG_VARIABLES, null),
  ]);
  output.configOrdered = ordered([
    ...runConfigRules(CONFIG_VARIABLES, null),
    ...runConfigRules(NULL_FILE_PRIV_VARIABLES, null),
    ...runConfigRules(CLEAN_CONFIG_VARIABLES, null),
  ]);

  output.performance = normalize(
    runPerformanceRules({
      metrics: buildMetrics(),
      variables: CONFIG_VARIABLES,
      processlist: PROCESSLIST,
      slowQueries: SLOW_QUERIES,
      replication: REPLICATION,
    }),
  );
  output.performanceOrdered = ordered(
    runPerformanceRules({
      metrics: buildMetrics(),
      variables: CONFIG_VARIABLES,
      processlist: PROCESSLIST,
      slowQueries: SLOW_QUERIES,
      replication: REPLICATION,
    }),
  );

  const covered = new Set<string>();
  for (const group of Object.values(output)) {
    const list = Array.isArray(group) ? group : [];
    for (const entry of list) {
      const findings = (entry.findings ?? [entry]) as Array<Record<string, unknown>>;
      for (const finding of findings) {
        if (typeof finding.ruleId === 'string') covered.add(finding.ruleId);
      }
    }
  }
  output.coveredRuleIds = Array.from(covered).sort();

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

void main();
