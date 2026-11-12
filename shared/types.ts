/**
 * Shared contracts between the Express API and the React client.
 * Keep this file free of Node/browser-only imports.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingCategory =
  'correctness' | 'performance' | 'security' | 'schema' | 'config' | 'style' | 'maintainability';
export type FindingSource = 'rule' | 'explain' | 'ai';

export interface FindingObject {
  database?: string;
  table?: string;
  column?: string;
  index?: string;
  user?: string;
  host?: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  message: string;
  /** AI findings may omit a recommendation; rules always provide one. */
  recommendation?: string;
  evidence?: string;
  line?: number | null;
  column?: number | null;
  object?: FindingObject;
  docs?: string;
  source: FindingSource;
  confidence?: 'high' | 'medium' | 'low';
  /**
   * Zero-based index of the statement the finding belongs to.
   *
   * Two statements can share a line, so the statement index is part of the
   * de-duplication key: without it, two findings for the same rule on the
   * same line collapse into one and a finding is silently dropped.
   */
  statementIndex?: number;
}

export interface ScoreResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  counts: Record<Severity, number>;
  deductions: Record<FindingCategory, number>;
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export interface SslConfig {
  enabled: boolean;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
}

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  socketPath?: string;
  ssl?: SslConfig;
  rememberPassword?: boolean;
  color?: string;
  databaseScope?: 'all' | 'selected';
  allowedDatabases?: string[];
  allowServerWideInsights?: boolean;
  /**
   * Whether members may write through this connection.
   *
   * `locked` means members cannot run write statements on it at all - they
   * cannot unlock it either. Administrators keep full write access on every
   * connection.
   */
  writeAccess?: WriteAccess;
}

/**
 * The write access a connection grants to members.
 *
 * - `full` (the default): members can unlock writes on this connection.
 * - `locked`: the connection is read-only for members. They cannot unlock it
 *   and they cannot reveal masked values through it. An administrator is not
 *   affected - an administrator always keeps full write access.
 */
export type WriteAccess = 'full' | 'locked';

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database?: string | null;
  socketPath?: string | null;
  ssl?: SslConfig | null;
  rememberPassword: boolean;
  hasPassword: boolean;
  passwordSource: 'saved' | 'none';
  color?: string | null;
  databaseScope: 'all' | 'selected';
  allowedDatabases: string[];
  allowServerWideInsights: boolean;
  /** Whether members may write through this connection. */
  writeAccess: WriteAccess;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export type SqlFlavor = 'mysql' | 'mariadb';

export interface ServerCapabilities {
  cte: boolean;
  windowFunctions: boolean;
  json: boolean;
  checkConstraints: boolean;
  roles: boolean;
  explainAnalyze: boolean;
  analyzeFormatJson: boolean;
  performanceSchema: boolean;
  sysSchema: boolean;
  replicaStatusCommand: 'SHOW REPLICA STATUS' | 'SHOW SLAVE STATUS';
  mysql8: boolean;
}

export interface ServerInfo {
  flavor: SqlFlavor;
  version: string;
  versionComment: string;
  uptimeSeconds: number;
  sqlMode: string;
  currentDatabase: string | null;
  capabilities: ServerCapabilities;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  server: ServerInfo | null;
  database: string | null;
  databases?: DatabaseInfo[];
  error?: string;
}

export interface CreateDatabaseInput {
  name: string;
  charset: string;
  collation: string;
  addToScope?: boolean;
}

export interface CreateDatabaseResult {
  database: DatabaseInfo;
  scopeUpdated: boolean;
  grantSql: string | null;
}

export interface CharsetInfo {
  charset: string;
  collations: { name: string; isDefault: boolean }[];
}

export interface GrantSqlRequest {
  profileId?: string;
  user: string;
  host?: string;
  databases: string[];
  privileges?: string[];
}

export interface GrantSqlResult {
  sql: string;
  warnings: string[];
}

export interface UnlockResult {
  unlocked: boolean;
  until: string | null;
  ttlSeconds: number;
}

/**
 * The clones one published database produced.
 *
 * A member never works in a published database directly: they work in their
 * own copy, so their writes never touch the administrator's data.
 */
export interface PublishResult {
  /** The source database that was published. */
  source: string;
  /** The clone each member received. */
  sandboxes: Array<{ userId: string; username: string; sandbox: string }>;
  /** Members who already had a clone of this source; they were left alone. */
  skipped: string[];
  /** Databases that could not be cloned, with the reason. */
  errors: string[];
}

/** The connection as saved, together with the clones the save produced. */
export interface ConnectionSaveResult extends ConnectionProfile {
  clones: PublishResult[];
}

export interface ConnectResult {
  server: ServerInfo;
  databases: DatabaseInfo[];
  unlock: UnlockResult;
}

/* ------------------------------------------------------------------ */
/* Database objects                                                    */
/* ------------------------------------------------------------------ */

export interface DatabaseInfo {
  name: string;
  isSystem: boolean;
  tableCount: number;
  viewCount: number;
  sizeBytes: number;
  collation: string | null;
}

export interface TableSummary {
  database: string;
  name: string;
  type: 'BASE TABLE' | 'VIEW' | 'SYSTEM VIEW';
  engine: string | null;
  rowsEstimate: number;
  dataBytes: number;
  indexBytes: number;
  dataFreeBytes: number;
  collation: string | null;
  comment: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ColumnInfo {
  name: string;
  position: number;
  dataType: string;
  columnType: string;
  nullable: boolean;
  defaultValue: string | null;
  extra: string;
  key: string;
  comment: string;
  charset: string | null;
  collation: string | null;
  generationExpression?: string | null;
}

export interface IndexColumn {
  name: string;
  subPart: number | null;
  collation: string | null;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  type: string;
  columns: IndexColumn[];
  cardinality: number | null;
  comment: string;
  redundantOf?: string | null;
  duplicateOf?: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedDatabase: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TriggerInfo {
  name: string;
  timing: string;
  event: string;
  table: string;
  statement: string;
  definer: string;
  created: string | null;
  sqlMode: string;
}

export interface RoutineInfo {
  name: string;
  type: 'FUNCTION' | 'PROCEDURE';
  definer: string;
  created: string | null;
  modified: string | null;
  securityType: string;
  comment: string;
  returnType?: string | null;
  parameters?: string | null;
  body?: string | null;
}

export interface ViewInfo {
  name: string;
  definer: string;
  securityType: string;
  checkOption: string;
  updatable: boolean;
  definition: string;
}

export interface EventInfo {
  name: string;
  definer: string;
  status: string;
  eventType: string;
  executeAt: string | null;
  intervalValue: string | null;
  intervalField: string | null;
  starts: string | null;
  ends: string | null;
  onCompletion: string;
  comment: string;
}

export interface PartitionInfo {
  name: string;
  method: string;
  expression: string | null;
  description: string | null;
  tableRows: number;
  dataBytes: number;
  indexBytes: number;
}

export interface CheckConstraintInfo {
  name: string;
  clause: string;
}

export interface TableDetail {
  summary: TableSummary;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  referencedBy: ForeignKeyInfo[];
  triggers: TriggerInfo[];
  checks: CheckConstraintInfo[];
  partitions: PartitionInfo[];
  createSql: string | null;
}

export interface DatabaseObjects {
  tables: TableSummary[];
  views: ViewInfo[];
  routines: RoutineInfo[];
  triggers: TriggerInfo[];
  events: EventInfo[];
}

export interface SchemaTable {
  database: string;
  name: string;
  type: 'BASE TABLE' | 'VIEW';
  engine: string | null;
  rowsEstimate: number;
  dataBytes: number;
  indexBytes: number;
  dataFreeBytes: number;
  collation: string | null;
  charset: string | null;
  comment: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface SchemaSnapshot {
  database: string;
  tables: SchemaTable[];
  fetchedAt: string;
}

export interface SchemaListItem {
  name: string;
  columns: string[];
}

export interface SchemaSummary {
  database: string;
  tables: SchemaListItem[];
  fetchedAt: string;
}

export interface TableDataRequest {
  limit?: number;
  offset?: number;
  orderBy?: string | null;
  orderDir?: 'asc' | 'desc';
  filters?: TableDataFilter[];
  revealSensitive?: boolean;
}

export interface TableDataFilter {
  column: string;
  operator: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'NOT LIKE' | 'IS NULL' | 'IS NOT NULL';
  value?: string;
}

/* ------------------------------------------------------------------ */
/* Query execution                                                     */
/* ------------------------------------------------------------------ */

export type StatementKind = 'read' | 'write' | 'ddl' | 'admin' | 'unknown';

export interface StatementClassification {
  kind: StatementKind;
  readOnly: boolean;
  destructive: boolean;
  needsUnlock: boolean;
  lockRead: boolean;
  executesQuery: boolean;
  reason?: string;
}

export interface ClassificationInfo extends StatementClassification {
  summary: string;
}

export interface BinaryCell {
  __type: 'binary';
  length: number;
  previewHex: string;
  truncated: boolean;
}

export type CellValue =
  string | number | boolean | null | BinaryCell | { [key: string]: unknown } | unknown[];

export interface QueryColumn {
  name: string;
  originalName: string;
  table: string | null;
  database: string | null;
  typeName: string;
  typeCode: number;
  flags: number;
  sensitive?: boolean;
}

export interface QueryWarning {
  level: string;
  code: number;
  message: string;
}

export interface QueryResult {
  sql: string;
  database: string | null;
  kind: StatementKind;
  columns: QueryColumn[];
  rows: CellValue[][];
  rowCount: number;
  truncated: boolean;
  affectedRows: number;
  insertId: string | null;
  info: string;
  warnings: QueryWarning[];
  executionMs: number;
  bytesApprox: number;
  unlocked: boolean;
  masked: boolean;
}

/* ------------------------------------------------------------------ */
/* EXPLAIN                                                             */
/* ------------------------------------------------------------------ */

export interface ExplainNode {
  id: string;
  label: string;
  table: string | null;
  accessType: string | null;
  key: string | null;
  possibleKeys: string[];
  rows: number | null;
  filtered: number | null;
  cost: number | null;
  extra: string[];
  children: ExplainNode[];
  runtimeRows?: number | null;
  runtimeFiltered?: number | null;
  runtimeMs?: number | null;
  /**
   * How often this node executed (`loops=N` of a MySQL EXPLAIN ANALYZE tree),
   * when known. `runtimeRows` holds the total across the loops for MySQL, so
   * per-iteration rows are `runtimeRows / runtimeLoops`.
   */
  runtimeLoops?: number | null;
}

export interface IndexSuggestion {
  database: string;
  table: string;
  columns: string[];
  reason: string;
  statement: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExplainResult {
  sql: string;
  analyzed: boolean;
  format: 'json' | 'text';
  nodes: ExplainNode[];
  insights: Finding[];
  suggestions: IndexSuggestion[];
  raw: unknown;
  text?: string;
  totalCost: number | null;
  executionMs: number;
}

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */

export interface ReviewTableContext {
  database: string;
  table: string;
  engine: string | null;
  rowsEstimate: number;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    key: string;
    extra: string;
    defaultValue: string | null;
  }[];
  indexes: { name: string; unique: boolean; columns: string[] }[];
  foreignKeys: {
    name: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
  }[];
}

export interface ReviewContextInfo {
  database: string | null;
  tables: ReviewTableContext[];
  truncated: boolean;
  charCount: number;
  estimatedTokens: number;
}

export interface StaticReviewResult {
  sql: string;
  statements: { sql: string; kind: StatementKind; line: number }[];
  findings: Finding[];
  score: ScoreResult;
  context: ReviewContextInfo;
  explain: ExplainResult | null;
  suggestions: IndexSuggestion[];
  warnings: string[];
}

export interface ReviewRequest {
  profileId: string;
  database?: string | null;
  sql: string;
  includeSchema?: boolean;
  includeExplain?: boolean;
  analyze?: boolean;
}

export interface AiReviewRequest {
  profileId?: string | null;
  database?: string | null;
  sql: string;
  providerId: string;
  model?: string;
  includeSchema?: boolean;
  includeExplain?: boolean;
  analyze?: boolean;
  explain?: ExplainResult | null;
  findings?: Finding[];
}

export interface AiRewrite {
  sql: string;
  /** Optional; omitted when the model gave no explanation. */
  explanation?: string;
}

export interface AiReview {
  providerId: string;
  providerName: string;
  model: string;
  verdict: 'pass' | 'warn' | 'fail' | 'unknown';
  score: number | null;
  /** Optional; omitted when the model gave no summary. */
  summary?: string;
  findings: Finding[];
  rewrite: AiRewrite | null;
  markdown: string;
  usage: AiUsage | null;
  durationMs: number;
  /**
   * Set when the provider answer could not be parsed and a second, billable
   * request was made to repair it.
   */
  repairAttempted?: boolean;
  /**
   * Set when the streaming call failed before the first token and the answer
   * was fetched with a second, billable non-streaming call instead.
   */
  streamingFallback?: boolean;
  /** Set when the provider returned more findings than the cap and some were dropped. */
  findingsTruncated?: boolean;
  /** How many findings the provider returned before the cap was applied. */
  findingsTotal?: number;
  /**
   * Non-fatal problems the caller should see: a schema that could not be read,
   * an extra billable provider call, a dropped part of the answer.
   */
  warnings?: string[];
}

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/**
 * One tool invocation inside an assistant turn, as the transcript shows it.
 * This is display-only state: the wire history stays text-only.
 */
export interface AgentToolCallView {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'complete' | 'error';
  /** The tool output (JSON text), truncated by the server. */
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Reasoning text a thinking model emitted before the answer. */
  thinking?: string;
  /** Tool calls this turn made, kept so the transcript shows the steps. */
  toolCalls?: AgentToolCallView[];
  /** Token usage of the turn, when the provider reported it. */
  usage?: ChatUsageLike | null;
}

export interface AiChatRequest {
  providerId: string;
  model?: string;
  messages: AiChatMessage[];
  context?: {
    sql?: string;
    database?: string | null;
    profileId?: string | null;
    includeSchema?: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Assistant                                                           */
/* ------------------------------------------------------------------ */

/**
 * `workspace` is the full-capability assistant; `challenge` is the guided
 * tutor that must never reveal the answer to a practice challenge.
 */
export type AssistantMode = 'workspace' | 'challenge';

/**
 * A challenge is addressed by its stored identity, never by its text. The
 * server loads the authoritative question so a client cannot rewrite the
 * prompt or smuggle the reference solution into the context.
 */
export interface AssistantQuestionRef {
  setId: string;
  questionId: string;
}

export interface AiAssistantRequest {
  mode: AssistantMode;
  providerId: string;
  model?: string;
  messages: AiChatMessage[];
  context?: {
    /** The current editor statement (workspace mode). */
    sql?: string;
    database?: string | null;
    profileId?: string | null;
    includeSchema?: boolean;
    /** The open practice challenge (challenge mode). */
    question?: AssistantQuestionRef;
  };
}

/** Why a challenge answer was withheld, reported to the client as a notice. */
export type AssistantGuardReason = 'solution-detected' | 'sql-statement-detected' | 'empty-answer';

export interface AssistantResult {
  text: string;
  usage: ChatUsageLike | null;
  /** Set when the challenge guard replaced an answer that would have leaked. */
  guarded?: AssistantGuardReason;
}

/** The `meta` event sent before an assistant turn streams. */
export interface AiAssistantMeta {
  providerId: string;
  providerName: string;
  model?: string;
  streaming: boolean;
  mode: AssistantMode;
  /** True when the turn runs through the agent loop (tools available). */
  agent?: boolean;
  /** Advertised tool names after governance, when `agent` is true. */
  tools?: string[];
}

export interface ChatUsageLike {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export type AuditStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface AuditStep {
  key: string;
  label: string;
  status: AuditStepStatus;
  detail?: string;
  durationMs?: number;
}

/**
 * A recurring unattended audit. Scheduled runs are always deterministic —
 * the rules/security/config/performance pipeline without the AI step — so a
 * schedule never spends tokens on its own.
 */
export interface AuditSchedule {
  id: string;
  profileId: string;
  databases: string[];
  intervalHours: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | 'running' | null;
  lastError?: string | null;
  createdAt: string;
}

export type CoverageStatus = 'ran' | 'skipped' | 'denied' | 'unsupported' | 'error';

export interface CoverageItem {
  check: string;
  status: CoverageStatus;
  reason?: string;
  count?: number | null;
}

export interface FindingGroup {
  ruleId: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  count: number;
  instances: Finding[];
  docs?: string;
}

export interface AuditStats {
  databases: number;
  tables: number;
  views: number;
  routines: number;
  triggers: number;
  events: number;
  columns: number;
  indexes: number;
  totalRowsEstimate: number;
  totalBytes: number;
}

export interface AuditEnvironment {
  [key: string]: string | number | boolean | null;
}

export interface AuditReport {
  id: string;
  kind: 'audit';
  title: string;
  createdAt: string;
  profile: { id: string; name: string; host: string; port: number; user: string };
  databaseScope: string[];
  server: ServerInfo | null;
  score: ScoreResult;
  findingsTotal: number;
  groups: FindingGroup[];
  coverage: CoverageItem[];
  environment: AuditEnvironment;
  stats: AuditStats;
  ai: AiReview | null;
  durationMs: number;
  steps: AuditStep[];
}

/* ------------------------------------------------------------------ */
/* Security                                                            */
/* ------------------------------------------------------------------ */

export interface DbUser {
  user: string;
  host: string;
  plugin: string;
  passwordSet: boolean;
  superPriv: boolean;
  filePriv: boolean;
  processPriv: boolean;
  grantPriv: boolean;
  shutdownPriv: boolean;
  createUserPriv: boolean;
  reloadPriv: boolean;
}

export interface GrantInfo {
  user: string;
  host: string;
  grants: string[];
}

export interface SecurityConfigSnapshot {
  localInfile: string | null;
  secureFilePriv: string | null;
  bindAddress: string | null;
  sqlMode: string | null;
  skipNameResolve: string | null;
}

export interface SecurityAuditResult {
  users: DbUser[];
  findings: Finding[];
  config: SecurityConfigSnapshot;
  coverage: CoverageItem[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Performance                                                         */
/* ------------------------------------------------------------------ */

export interface PerformanceMetrics {
  uptimeSeconds: number;
  qps: number;
  threadsConnected: number;
  threadsRunning: number;
  maxUsedConnections: number;
  abortedConnects: number;
  abortedClients: number;
  slowQueries: number;
  selectScan: number;
  selectFullJoin: number;
  tmpDiskTables: number;
  tmpTables: number;
  bufferPoolHitRatio: number | null;
  tableLocksWaited: number;
  innodbDeadlocks: number;
  bytesReceived: number;
  bytesSent: number;
  openTables: number;
  queries: number;
}

export interface ProcessInfo {
  id: number;
  user: string;
  host: string;
  db: string | null;
  command: string;
  timeSeconds: number;
  state: string | null;
  info: string | null;
}

export interface SlowQueryInfo {
  digest: string;
  digestText: string;
  schemaName: string | null;
  count: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  rowsExamined: number;
  rowsSent: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /**
   * Digest-only enrichment below, present when the row came from
   * performance_schema and the server carries the column. Slow-log rows leave
   * these undefined.
   */
  /** Executions that scanned without using any index (full scans). */
  noIndexUsed?: number;
  /** Executions where no index was usable at all. */
  noGoodIndexUsed?: number;
  tmpTables?: number;
  tmpDiskTables?: number;
  /** 95th / 99th percentile latency in ms (MySQL >= 8.0.19 digests only). */
  quantile95Ms?: number;
  quantile99Ms?: number;
}

export interface ReplicationStatus {
  configured: boolean;
  ioRunning: string | null;
  sqlRunning: string | null;
  lagSeconds: number | null;
}

/**
 * One waiter → blocker link in the current lock-wait graph. The transaction
 * and thread ids match what the process list shows, so a blocker can be
 * traced back to a session. `lockType` / `lockMode` describe the lock the
 * waiter asked for; `heldLockMode` is the conflicting mode the blocker holds.
 */
export interface LockWaitInfo {
  waiterTrxId: string;
  waiterQuery: string | null;
  waiterThread: number | null;
  blockerTrxId: string;
  blockerQuery: string | null;
  blockerThread: number | null;
  waitSeconds: number;
  lockType: string | null;
  lockMode: string | null;
  lockedTable: string | null;
  lockedIndex: string | null;
  heldLockMode: string | null;
}

/**
 * Lock-wait data for one server. When the source tables are unavailable
 * (performance_schema off, missing privileges) `waits` is empty and `reason`
 * explains why.
 */
export interface LockWaitsSnapshot {
  waits: LockWaitInfo[];
  reason: string | null;
}

/** One table's I/O since server start, from performance_schema. */
export interface TableIoInfo {
  database: string;
  table: string;
  countStar: number;
  countRead: number;
  countWrite: number;
  totalLatencyMs: number;
}

export interface TableIoHotspots {
  tables: TableIoInfo[];
  reason: string | null;
}

export interface PerformanceSnapshot {
  metrics: PerformanceMetrics;
  status: Record<string, string>;
  variables: Record<string, string>;
  processlist: ProcessInfo[];
  slowQueries: SlowQueryInfo[];
  slowQuerySource: 'performance_schema' | 'slow_log' | 'none';
  slowQueryAdvice: string | null;
  replication: ReplicationStatus;
  topTables: { database: string; table: string; rowsEstimate: number; totalBytes: number }[];
  /** Top tables by I/O wait since server start (empty when performance_schema is off). */
  tableIo: TableIoInfo[];
  tableIoReason: string | null;
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* AI providers                                                        */
/* ------------------------------------------------------------------ */

export type AiProviderType = 'openai' | 'anthropic' | 'google';

export interface AiProvider {
  id: string;
  name: string;
  type: AiProviderType;
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
  model: string;
  models: string[];
  hasApiKey: boolean;
  apiKeyHint: string | null;
  authHeader: string;
  authPrefix: string;
  /**
   * Custom request headers. The values are secrets, so the shape that is
   * sent to a client holds masked placeholders (the header names are the
   * keys); the decrypted values are only used to build the outbound request.
   */
  headers: Record<string, string>;
  extraBody: Record<string, unknown>;
  temperature: number;
  maxTokens: number;
  streaming: boolean;
  /**
   * Anthropic extended thinking: the provider is called with a thinking
   * budget and its reasoning streams into the thinking lane. Ignored by
   * non-Anthropic providers.
   */
  thinkingEnabled?: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiProviderInput {
  name: string;
  type: AiProviderType;
  baseUrl: string;
  chatPath?: string;
  modelsPath?: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  authHeader?: string;
  authPrefix?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
  thinkingEnabled?: boolean;
  isDefault?: boolean;
}

export interface AiProviderTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  models: string[];
  detectedModel: string | null;
}

export interface AiProviderPreset {
  id: string;
  label: string;
  description: string;
  type: AiProviderType;
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
  model: string;
  authHeader: string;
  authPrefix: string;
  needsKey: boolean;
}

/* ------------------------------------------------------------------ */
/* SQL Lab (practice challenges)                                       */
/* ------------------------------------------------------------------ */

export type PracticeTaskType = 'write-query' | 'fix-query' | 'review-query' | 'concept';
export type PracticeDifficulty = 'easy' | 'medium' | 'hard';
export type PracticeTopic =
  | 'select'
  | 'joins'
  | 'aggregation'
  | 'subqueries'
  | 'cte'
  | 'window'
  | 'set-ops'
  | 'dml'
  | 'ddl'
  | 'indexes'
  | 'transactions'
  | 'views'
  | 'procedures'
  | 'triggers'
  | 'design'
  | 'security';

/**
 * Server-internal / at-rest shape of a practice question. It carries the grading
 * material (`brokenSql`, `referenceSql`, `expectedResult`) and must never be sent
 * to the browser for an unanswered question — use `PracticeQuestionPublic` on the
 * wire instead.
 */
/**
 * Three progressive hint tiers the model is asked to produce. Tiers are absent
 * when the model omitted them or when the leak filter dropped them, so every
 * member is optional. `nudge` and `approach` are words only; `skeleton` may
 * carry partial SQL but never the full answer (the leak filter guards that).
 */
export interface PracticeHintLadder {
  /** Which clause or topic to look at; never SQL. */
  nudge?: string;
  /** The strategy in words; never SQL. */
  approach?: string;
  /** A partial SQL skeleton, at most one line per clause; not the answer. */
  skeleton?: string;
}

export interface PracticeQuestion {
  id: string;
  type: PracticeTaskType;
  title: string;
  scenario: string;
  difficulty: PracticeDifficulty;
  topics: PracticeTopic[];
  schemaTables: string[];
  brokenSql: string | null;
  referenceSql: string | null;
  expectedResult: string | null;
  orderMatters: boolean;
  hints: string[];
  /** Tiered hints when the model produced them; `hints` stays the flat union. */
  hintLadder?: PracticeHintLadder;
  estimatedMinutes: number;
  execute: boolean;
}

/**
 * Client-safe practice question. The reference solution and the expected output
 * are withheld until the profile has attempted the question; after that they are
 * available from `GET /api/practice/sets/:id/answers`. The deliberately broken
 * input is also withheld, except for `fix-query` tasks where it is the prompt
 * itself and must be visible before an attempt.
 */
export type PracticeQuestionPublic = Omit<
  PracticeQuestion,
  'brokenSql' | 'referenceSql' | 'expectedResult'
> & {
  /** Present only for `fix-query` questions. */
  brokenSql?: string | null;
};

export interface PracticeSet {
  id: string;
  /** Authenticated account that generated the set. Required for all new data. */
  userId?: string;
  profileId: string;
  createdAt: string;
  database: string;
  providerId: string;
  model: string;
  summary: string;
  questions: PracticeQuestion[];
}

/** Wire shape of a practice set: questions are stripped of answer material. */
export interface PracticeSetPublic extends Omit<PracticeSet, 'questions'> {
  questions: PracticeQuestionPublic[];
}

/** Answer material released after a question has been attempted. */
export interface PracticeAnswer {
  questionId: string;
  referenceSql: string | null;
  expectedResult: string | null;
  brokenSql: string | null;
  orderMatters: boolean;
}

export interface PracticeAnswers {
  setId: string;
  answers: PracticeAnswer[];
}

export interface PracticeGenerateRequest {
  profileId: string;
  database: string;
  tables?: string[];
  topics: PracticeTopic[];
  difficulty: PracticeDifficulty | 'mixed';
  count: number;
  providerId: string;
  model?: string;
  includeSampleData?: boolean;
}

export interface PracticeComparison {
  matched: boolean;
  reason: string;
  ordered: boolean;
  userRowCount: number | null;
  referenceRowCount: number | null;
  columnCountUser: number | null;
  columnCountReference: number | null;
  missingRows: unknown[][];
  extraRows: unknown[][];
  matchedRows: number;
  unmatchedRows: number;
  truncated: boolean;
}

export interface PracticeScores {
  correctness: number;
  performance: number;
  style: number;
  overall: number;
}

export interface PracticeEvaluation {
  questionId: string;
  executed: boolean;
  verdict: 'correct' | 'close' | 'incorrect' | 'not-executed';
  scores: PracticeScores;
  summary: string;
  strengths: string[];
  issues: string[];
  nextHint: string;
  comparison: PracticeComparison | null;
  findings: Finding[];
  explain: ExplainResult | null;
  aiFeedback: string | null;
  referenceSql: string | null;
  userSql: string | null;
  userAnswer: string | null;
  userResult: QueryResult | null;
  referenceResult: QueryResult | null;
  /** Set when the submission matched an earlier attempt and nothing was recorded. */
  duplicate?: boolean;
  /**
   * Set when the grading answer could not be parsed and a second, billable
   * provider request was made to repair it.
   */
  aiRepairAttempted?: boolean;
}

/** Wire shape of an evaluation inside attempt listings: no reference material. */
export type PracticeEvaluationPublic = Omit<PracticeEvaluation, 'referenceSql' | 'referenceResult'>;

export interface PracticeEvaluateRequest {
  profileId: string;
  setId: string;
  questionId: string;
  userSql?: string;
  userAnswer?: string;
  providerId?: string;
  model?: string;
  includeAi?: boolean;
}

export interface PracticeAttempt {
  id: string;
  /** Authenticated account that submitted the attempt. Required for all new data. */
  userId?: string;
  profileId: string;
  setId: string;
  questionId: string;
  database: string;
  topics: PracticeTopic[];
  difficulty: PracticeDifficulty;
  userSql: string;
  userAnswer: string;
  evaluation: PracticeEvaluation;
  createdAt: string;
}

/** Wire shape of an attempt: the embedded evaluation drops reference material. */
export interface PracticeAttemptPublic extends Omit<PracticeAttempt, 'evaluation'> {
  evaluation: PracticeEvaluationPublic;
}

export interface PracticeProgressTopic {
  topic: PracticeTopic;
  attempts: number;
  averageScore: number;
  bestScore: number;
}

export interface PracticeProgress {
  totalAttempts: number;
  averageScore: number;
  topics: PracticeProgressTopic[];
  recent: PracticeAttempt[];
  recommendedTopics: PracticeTopic[];
  /** Consecutive local calendar days with at least one attempt, ending today (or yesterday). */
  currentStreak?: number;
  /** Longest consecutive-day run found in the retained attempt history. */
  longestStreak?: number;
  /** Score-weighted experience points over the retained attempts. */
  xp?: number;
}

/** Wire shape of progress: recent attempts drop reference material. */
export interface PracticeProgressPublic extends Omit<PracticeProgress, 'recent'> {
  recent: PracticeAttemptPublic[];
}

export interface PracticeGenerateResult {
  set: PracticeSet;
}

/* ------------------------------------------------------------------ */
/* SQL Lab learning loop (review queue, daily challenge)               */
/* ------------------------------------------------------------------ */

/** Verdicts that schedule a spaced-repetition review. */
export type PracticeReviewVerdict = 'correct' | 'close' | 'incorrect';

/** The intervals a `correct` answer earns, indexed by the box it just left. */
export const PRACTICE_REVIEW_INTERVAL_DAYS = [3, 7, 14, 30] as const;

/**
 * One due review card as the wire shape of `GET /api/practice/review`. It
 * carries the question text only: reference answers never travel on this
 * endpoint, exactly as for an unattempted question elsewhere.
 */
export interface PracticeReviewQueueItem {
  setId: string;
  questionId: string;
  title: string;
  scenario: string;
  topics: PracticeTopic[];
  difficulty: PracticeDifficulty;
  /** SM-2-lite box the item is in (0 = relearn). */
  box: number;
  /** ISO timestamp; the item is due when this is in the past. */
  dueAt: string;
  lastVerdict: PracticeReviewVerdict;
  lastAttemptAt: string;
}

/** Stored pointer to the profile's daily challenge (local calendar date). */
export interface PracticeDailyEntry {
  /** Local date in `YYYY-MM-DD` form. */
  date: string;
  setId: string;
}

/** Wire shape of `GET /api/practice/daily`. */
export interface PracticeDaily {
  date: string;
  /** Null when no daily challenge could be generated or picked; `reason` says why. */
  set: PracticeSetPublic | null;
  /** `no-provider` or `generation-failed` when `set` is null. */
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Settings, history, snippets, reports                                */
/* ------------------------------------------------------------------ */

export type ThemePreference = 'dark' | 'light' | 'system';

export interface AppSettings {
  theme: ThemePreference;
  rowLimit: number;
  queryTimeoutMs: number;
  cellMaxChars: number;
  liveLint: boolean;
  includeSchemaByDefault: boolean;
  aiContextChars: number;
  defaultAiProviderId: string | null;
  historyLimit: number;
  showHints: boolean;
  maskSensitiveColumns: boolean;
  /**
   * Global write-unlock switch. `false` puts the whole app in hard read-only
   * mode: nobody — administrators included — can unlock writes or reveal masked
   * values. Optional so a settings file written by an older build still loads;
   * absent means enabled.
   */
  writeUnlockEnabled?: boolean;
  /**
   * Built-in agent tools an administrator has switched off. Enforced
   * server-side when the agent toolset is built. Optional for the same
   * reason as `writeUnlockEnabled`; absent means every tool is available.
   */
  disabledAgentTools?: string[];
  /**
   * Local MCP (Model Context Protocol) servers the agent may reach over
   * stdio. Admin-configured; a server that fails to start is skipped, never
   * fatal. Optional for the same reason as the other newer fields.
   */
  mcpServers?: McpServerConfig[];
}

export interface McpServerConfig {
  /** Unique slug; tool names are prefixed with it. */
  name: string;
  /** The executable to spawn (resolved via PATH; spawned without a shell). */
  command: string;
  args?: string[];
  /** When set, only these tool names are exposed from this server. */
  allowedTools?: string[];
}

export interface HistoryEntry {
  id: string;
  profileId: string;
  database: string | null;
  sql: string;
  kind: StatementKind;
  success: boolean;
  executionMs: number;
  rowCount: number | null;
  error: string | null;
  createdAt: string;
  /** Absent on entries created before the admin layer (admin-visible only). */
  userId?: string;
}

export interface Snippet {
  id: string;
  title: string;
  sql: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Absent on snippets created before the admin layer (admin-visible only). */
  userId?: string;
}

export interface ReportSummary {
  id: string;
  kind: 'audit' | 'review';
  title: string;
  createdAt: string;
  score: number;
  grade: string;
  findingsTotal: number;
  databaseScope: string[];
  hasAi: boolean;
}

export interface DetectedXampp {
  path: string;
  port: number | null;
  version?: string | null;
}

/* ------------------------------------------------------------------ */
/* Accounts, sandboxes, activity                                       */
/* ------------------------------------------------------------------ */

export type UserRole = 'admin' | 'member';

/**
 * A database cloned for one member from a source database on an assigned
 * connection. Members hold full write control inside their sandboxes and no
 * access outside them; the counter suffix (`northwind_1`) keeps copies apart.
 */
export interface SandboxAssignment {
  id: string;
  profileId: string;
  /** The admin-owned database the sandbox was cloned from. */
  source: string;
  sandbox: string;
  includeData: boolean;
  createdAt: string;
  lastResetAt?: string | null;
}

/** User shape safe to send to any signed-in client (no password material). */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  assignments: SandboxAssignment[];
  createdAt: string;
  disabledAt?: string | null;
  /** Personal appearance override; null means use the admin default theme. */
  theme?: ThemePreference | null;
  /**
   * When true this account can never unlock writes, even while the global
   * write-unlock switch is on. Optional so a users file written by an older
   * build still loads; absent means "not disabled".
   */
  writeUnlockDisabled?: boolean;
}

export interface AuthInfo {
  /** True until the first admin account exists; the app then shows setup. */
  needsSetup: boolean;
}

export type ActivityAction =
  | 'login'
  | 'logout'
  | 'connect'
  | 'disconnect'
  | 'query'
  | 'unlock'
  | 'lock'
  | 'audit'
  | 'practice-generate'
  | 'practice-evaluate'
  | 'practice-daily'
  | 'report-export'
  | 'report-delete'
  | 'admin-user-create'
  | 'admin-user-update'
  | 'admin-user-delete'
  | 'admin-sandbox-provision'
  | 'admin-sandbox-reset'
  | 'admin-connection-create'
  | 'admin-connection-update'
  | 'admin-connection-delete'
  | 'admin-write-unlock-switch';

export interface ActivityEntry {
  id: string;
  at: string;
  userId: string;
  username: string;
  action: ActivityAction;
  profileId?: string;
  database?: string;
  /** sha256 of the statement, so logs identify queries without storing them. */
  digest?: string;
  detail?: string;
}

/** One page of the admin activity log, newest entry first. */
export interface ActivityPage {
  entries: ActivityEntry[];
  /** Total entries matching the filter, for pagination controls. */
  total: number;
}

export interface BootstrapInfo {
  appName: string;
  version: string;
  token: string;
  platform: string;
  nodeVersion: string;
  dataDir: string;
  clientBuilt: boolean;
  detectedXampp: DetectedXampp | null;
  profiles: ConnectionProfile[];
  providers: AiProvider[];
  settings: AppSettings;
  activeProfileId: string | null;
  auth: AuthInfo;
  currentUser: PublicUser | null;
}

export interface StoredReviewReport {
  id: string;
  kind: 'review';
  title: string;
  createdAt: string;
  profile: { id: string; name: string; host: string; port: number; user: string } | null;
  databaseScope: string[];
  sql: string;
  review: StaticReviewResult;
  ai: AiReview | null;
}

/** Response of `POST /api/review/save`. */
export interface SavedReviewResult {
  id: string;
  title: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const APP_NAME = 'MyLens';
export const APP_VERSION = '1.1.0';

export const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  correctness: 'Correctness',
  performance: 'Performance',
  security: 'Security',
  schema: 'Schema',
  config: 'Configuration',
  style: 'Style',
  maintainability: 'Maintainability',
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  rowLimit: 1000,
  queryTimeoutMs: 30_000,
  cellMaxChars: 16_384,
  liveLint: true,
  includeSchemaByDefault: true,
  aiContextChars: 24_000,
  defaultAiProviderId: null,
  historyLimit: 500,
  showHints: true,
  maskSensitiveColumns: true,
  writeUnlockEnabled: true,
  disabledAgentTools: [],
  mcpServers: [],
};

export const PRACTICE_TOPICS: { id: PracticeTopic; label: string }[] = [
  { id: 'select', label: 'SELECT & filtering' },
  { id: 'joins', label: 'Joins' },
  { id: 'aggregation', label: 'Aggregation' },
  { id: 'subqueries', label: 'Subqueries' },
  { id: 'cte', label: 'CTEs' },
  { id: 'window', label: 'Window functions' },
  { id: 'set-ops', label: 'Set operations' },
  { id: 'dml', label: 'DML' },
  { id: 'ddl', label: 'DDL' },
  { id: 'indexes', label: 'Indexes & EXPLAIN' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'views', label: 'Views' },
  { id: 'procedures', label: 'Stored procedures & functions' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'design', label: 'Schema design' },
  { id: 'security', label: 'Security' },
];

export const PRACTICE_DIFFICULTIES: { id: PracticeDifficulty | 'mixed'; label: string }[] = [
  { id: 'mixed', label: 'Mixed' },
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
];

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Official OpenAI API',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    model: 'gpt-4.1-mini',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Many models through one OpenAI-compatible endpoint',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    model: 'anthropic/claude-sonnet-4',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    needsKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek OpenAI-compatible API',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    model: 'deepseek-chat',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    needsKey: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Fast OpenAI-compatible inference',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    model: 'llama-3.3-70b-versatile',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    description: 'Local models served by Ollama',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    model: 'qwen2.5-coder:7b',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    needsKey: false,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    description: 'Local OpenAI-compatible server',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    model: 'local-model',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    needsKey: false,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models via the native Messages API',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    chatPath: '/v1/messages',
    modelsPath: '/v1/models',
    model: 'claude-sonnet-4-20250514',
    authHeader: 'x-api-key',
    authPrefix: '',
    needsKey: true,
  },
  {
    id: 'google',
    label: 'Google Gemini',
    description: 'Gemini models via the native API',
    type: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    chatPath: '',
    modelsPath: '/models',
    model: 'gemini-2.5-flash',
    authHeader: '',
    authPrefix: '',
    needsKey: true,
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    description: 'Any OpenAI-compatible server, gateway, or proxy',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    model: '',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    needsKey: false,
  },
];
