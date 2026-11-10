import crypto from 'node:crypto';
import sqlParser from 'node-sql-parser';
import type { RowDataPacket } from 'mysql2/promise';
import type { ExplainNode, ExplainResult, Finding } from '../../shared/types';
import { AppError } from '../errors';
import { getSettings } from '../store/settings';
import { resolveWriteUnlock } from '../store/users';
import { getStoredProfile } from '../store/profiles';
import { classifySql } from '../review/sql-classifier';
import { connectProfile, getCachedServerInfo, withConnection } from './manager';
import { applyQueryGuards } from './dialect';
import { assertSqlScope } from './scope';

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

const CONTAINER_KEYS = new Set([
  'query_block',
  'nested_loop',
  'ordering_operation',
  'grouping_operation',
  'duplicates_removal',
  'materialized_from_subquery',
  'subqueries',
  'union_result',
  'table',
  'filesort',
  'temporary_table',
  'buffer_result',
  'join_execution',
  'windowing',
  'attached_subqueries',
]);

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value == null) return [];
  return [String(value)];
}

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectFlags(value: Record<string, unknown>, inherited: string[]): string[] {
  const flags = [...inherited];
  if (value.using_filesort) flags.push('using filesort');
  if (value.using_temporary_table || value.temporary_table) flags.push('using temporary');
  if (value.using_index) flags.push('using index');
  if (value.using_index_condition) flags.push('using index condition');
  if (value.using_join_buffer) {
    flags.push(`using join buffer (${String(value.using_join_buffer)})`);
  }
  if (value.attached_condition) {
    flags.push(`attached condition: ${String(value.attached_condition).slice(0, 300)}`);
  }
  return flags;
}

function makeNode(value: Record<string, unknown>, flags: string[]): ExplainNode {
  const tableName = value.table_name == null ? null : String(value.table_name);
  const accessType = value.access_type == null ? null : String(value.access_type);
  const possibleKeys = [
    ...asArray(value.possible_keys),
    ...asArray(value.possible_keys_expect),
  ].filter((key, index, all) => all.indexOf(key) === index);
  const costInfo = (value.cost_info ?? {}) as Record<string, unknown>;
  const cost =
    asNumber(costInfo.prefix_cost) ?? asNumber(costInfo.read_cost) ?? asNumber(value.cost);

  return {
    id: crypto.randomUUID(),
    label: tableName ?? String(value.select_id ?? 'plan'),
    table: tableName,
    accessType,
    key: value.key == null ? null : String(value.key),
    possibleKeys,
    rows:
      asNumber(value.rows_examined_per_scan) ??
      asNumber(value.rows) ??
      asNumber(value.rows_produced_per_join),
    filtered: asNumber(value.filtered) ?? asNumber(value.r_filtered),
    cost,
    extra: flags,
    children: [],
    runtimeRows: asNumber(value.r_rows),
    runtimeFiltered: asNumber(value.r_filtered),
    runtimeMs: asNumber(value.r_total_time_ms),
  };
}

function visit(value: unknown, inherited: string[] = []): ExplainNode[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => visit(item, inherited));
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const flags = collectFlags(record, inherited);

  if (record.table_name) {
    const node = makeNode(record, flags);
    for (const [key, child] of Object.entries(record)) {
      if (!CONTAINER_KEYS.has(key)) continue;
      node.children.push(...visit(child, flags));
    }
    return [node];
  }

  const nodes: ExplainNode[] = [];
  for (const [key, child] of Object.entries(record)) {
    if (!CONTAINER_KEYS.has(key)) continue;
    nodes.push(...visit(child, flags));
  }
  return nodes;
}

function findTotalCost(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTotalCost(item);
      if (found != null) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const costInfo = record.cost_info as Record<string, unknown> | undefined;
  const direct = asNumber(costInfo?.query_cost) ?? asNumber(record.cost);
  if (direct != null) return direct;
  for (const child of Object.values(record)) {
    const found = findTotalCost(child);
    if (found != null) return found;
  }
  return null;
}

/** Actual-vs-estimated row ratio beyond which the estimate counts as drifted. */
const DRIFT_RATIO = 5;

/** Actual rows below which a drift signal is too noisy to report. */
const DRIFT_MIN_ACTUAL_ROWS = 500;

/**
 * Rows the node actually produced per iteration.
 *
 * MySQL's EXPLAIN ANALYZE `rows` is a per-loop average and `runtimeRows`
 * stores the total across the loops (`rows * loops`), so the loops are
 * divided out again. MariaDB's `r_rows` is already the per-loop average and
 * carries no loop count, so it is used as-is.
 */
function actualRowsPerLoop(node: ExplainNode): number | null {
  const runtimeRows = node.runtimeRows;
  if (runtimeRows == null) return null;
  const loops = node.runtimeLoops;
  if (loops != null && loops > 1) return runtimeRows / loops;
  return runtimeRows;
}

function addFinding(
  findings: Finding[],
  ruleId: string,
  title: string,
  severity: Finding['severity'],
  message: string,
  recommendation: string,
  node: ExplainNode,
): void {
  if (
    findings.some((finding) => finding.ruleId === ruleId && finding.object?.table === node.table)
  ) {
    return;
  }
  findings.push({
    id: crypto.randomUUID(),
    ruleId,
    title,
    severity,
    category: 'performance',
    message,
    recommendation,
    evidence: `access_type=${node.accessType ?? 'n/a'} rows=${node.rows ?? 'n/a'} key=${node.key ?? 'none'}`,
    line: null,
    column: null,
    object: { table: node.table ?? undefined },
    docs: 'https://dev.mysql.com/doc/refman/8.0/en/explain-output.html',
    source: 'explain',
    confidence: 'high',
  });
}

/* ------------------------------------------------------------------ */
/* MySQL `EXPLAIN ANALYZE` tree parsing                                */
/* ------------------------------------------------------------------ */

/**
 * MySQL prints `EXPLAIN ANALYZE` as an indented tree, one operator per line:
 *
 * ```
 * -> Nested loop inner join  (cost=1.10 rows=20) (actual time=0.15..0.55 rows=20 loops=1)
 *     -> Table scan on t1  (cost=0.75 rows=10) (actual time=0.05..0.10 rows=10 loops=1)
 *     -> Filter: (t2.b = t1.a)  (actual time=0.05..0.30 rows=2 loops=20)
 *         -> Index lookup on t2 using idx_b  (cost=0.35 rows=2) (actual time=0.01..0.05 rows=2 loops=20)
 * ```
 *
 * The indentation is a plain leading-space count that grows with the depth
 * (the exact width has varied across MySQL versions), so the tree is rebuilt
 * with a stack: a line less indented than the current top closes it, and a
 * more indented line becomes its child. Operators print no table name (joins,
 * sorts, `Rows fetched before initialization`); for the ones that do, the
 * table comes from the label (`Table scan on t1`, `Index lookup on t2 using
 * idx`) and the access type is inferred from the same label as a best effort.
 *
 * Parsed values:
 * - The first parenthesized group that is not the actual group holds the
 *   estimates: `rows=N` and optionally `cost=N` (a `cost=a..b` range takes the
 *   second number, which is the total). Labels may hold their own parentheses
 *   (`Filter: (t1.a = t1.b)`), so groups are recognized by content, not by
 *   position.
 * - The `(actual time=a..b rows=N loops=N)` group holds the runtimes. `a..b`
 *   are milliseconds since the statement started, and `b` - the node's total
 *   time - becomes `runtimeMs`. `rows` is the per-iteration average, so the
 *   total across the `loops` executions (`rows * loops`) becomes
 *   `runtimeRows`, with `runtimeLoops` keeping the loop count. MySQL 8.0.18+
 *   may print the time list bracketed (`actual time=[a..b]`) and a single
 *   value without the second bound; both are accepted. Nodes without an
 *   actual group (no runtimes collected) parse with null runtimes.
 */

const ANALYZE_LINE_RE = /^(\s*)->\s?(.*)$/;
const ANALYZE_ESTIMATE_ROWS_RE = /(?:^|[\s(])rows=(\d+)/;
const ANALYZE_COST_RE = /\bcost=(\d+(?:\.\d+)?)(?:\.\.(\d+(?:\.\d+)?))?/;
const ANALYZE_ACTUAL_TIME_RE =
  /\bactual time=(?:\[)?(\d+(?:\.\d+)?)(?:\.\.(\d+(?:\.\d+)?))?(?:\])?/;
const ANALYZE_ACTUAL_ROWS_RE = /(?:^|[\s,])rows=(\d+)/;
const ANALYZE_LOOPS_RE = /\bloops=(\d+)/;
const ANALYZE_TABLE_RE = /\bon\s+`?([A-Za-z0-9_$]+)`?/;
const ANALYZE_KEY_RE = /\busing\s+`?([A-Za-z0-9_$]+)`?/;

/** Best-effort access type for the labels that unambiguously name one. */
function accessTypeFromLabel(label: string): string | null {
  if (/^table scan/i.test(label)) return 'ALL';
  if (/^single-row index lookup/i.test(label)) return 'eq_ref';
  if (/^index range scan/i.test(label)) return 'range';
  if (/^index scan/i.test(label)) return 'index';
  if (/^index lookup/i.test(label)) return 'ref';
  return null;
}

interface TreeGroup {
  content: string;
  start: number;
}

/** The top-level parenthesized spans of a node line, with their offsets. */
function topLevelGroups(text: string): TreeGroup[] {
  const groups: TreeGroup[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        groups.push({ content: text.slice(start + 1, i), start });
        start = -1;
      }
      if (depth < 0) depth = 0; // a stray closer: ignore it
    }
  }
  return groups;
}

function parseAnalyzeNodeLine(line: string): ExplainNode {
  const groups = topLevelGroups(line);
  let estimate: TreeGroup | null = null;
  let actual: TreeGroup | null = null;
  for (const group of groups) {
    if (actual === null && /\bactual\b/.test(group.content)) actual = group;
    else if (estimate === null && /\b(?:rows|cost)=/.test(group.content)) estimate = group;
  }

  // The label is everything before the first estimate/actual group, so a
  // condition inside the label keeps its own parentheses.
  const labelEnd = estimate?.start ?? actual?.start ?? line.length;
  const label = line.slice(0, labelEnd).trim() || line.trim();

  const estimateRows = estimate ? ANALYZE_ESTIMATE_ROWS_RE.exec(estimate.content)?.[1] : undefined;
  const costMatch = estimate ? ANALYZE_COST_RE.exec(estimate.content) : null;
  const timeMatch = actual ? ANALYZE_ACTUAL_TIME_RE.exec(actual.content) : null;
  const actualRows = actual
    ? asNumber(ANALYZE_ACTUAL_ROWS_RE.exec(actual.content)?.[1] ?? null)
    : null;
  const loops = actual ? asNumber(ANALYZE_LOOPS_RE.exec(actual.content)?.[1] ?? null) : null;

  const tableMatch = ANALYZE_TABLE_RE.exec(label);
  const keyMatch = ANALYZE_KEY_RE.exec(label);

  return {
    id: crypto.randomUUID(),
    label,
    table: tableMatch ? tableMatch[1] : null,
    accessType: accessTypeFromLabel(label),
    key: keyMatch ? keyMatch[1] : null,
    possibleKeys: [],
    rows: estimateRows == null ? null : asNumber(estimateRows),
    filtered: null,
    cost: costMatch ? asNumber(costMatch[2] ?? costMatch[1]) : null,
    extra: [],
    children: [],
    runtimeRows: actualRows != null && loops != null && loops > 1 ? actualRows * loops : actualRows,
    runtimeFiltered: null,
    runtimeMs: timeMatch ? asNumber(timeMatch[2] ?? timeMatch[1]) : null,
    runtimeLoops: loops,
  };
}

/**
 * Parse a MySQL `EXPLAIN ANALYZE` tree into plan nodes.
 *
 * Lines that do not start with an indented `->` marker (blank lines, client
 * notices) are skipped, so a partially unreadable tree yields the nodes that
 * did parse instead of failing the explain.
 */
export function parseExplainAnalyzeTree(text: string): ExplainNode[] {
  const roots: ExplainNode[] = [];
  const stack: { indent: number; node: ExplainNode }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ANALYZE_LINE_RE.exec(line);
    if (!match) continue;
    const node = parseAnalyzeNodeLine(match[2]);
    const indent = match[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length > 0) {
      stack[stack.length - 1].node.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push({ indent, node });
  }
  return roots;
}

/**
 * Copy the runtime values of a parsed `EXPLAIN ANALYZE` tree onto the nodes
 * parsed from `EXPLAIN FORMAT=JSON`.
 *
 * On MySQL the JSON plan holds the estimates (and `access_type`, `filtered`)
 * while the tree holds the runtimes, so the two are merged: nodes are matched
 * by table name in plan order, which keeps a self-join's two nodes apart.
 */
export function mergeAnalyzeRuntime(nodes: ExplainNode[], tree: ExplainNode[]): void {
  const flat: ExplainNode[] = [];
  const collect = (list: ExplainNode[]): void => {
    for (const node of list) {
      flat.push(node);
      collect(node.children);
    }
  };
  collect(tree);

  const byTable = new Map<string, ExplainNode[]>();
  for (const node of flat) {
    if (!node.table) continue;
    const list = byTable.get(node.table);
    if (list) list.push(node);
    else byTable.set(node.table, [node]);
  }

  const used = new Set<ExplainNode>();
  const apply = (target: ExplainNode, source: ExplainNode): void => {
    if (target.runtimeMs == null) target.runtimeMs = source.runtimeMs;
    if (target.runtimeRows == null) target.runtimeRows = source.runtimeRows;
    if (target.runtimeLoops == null) target.runtimeLoops = source.runtimeLoops;
    if (target.rows == null) target.rows = source.rows;
    if (target.cost == null) target.cost = source.cost;
  };
  const walk = (list: ExplainNode[]): void => {
    for (const node of list) {
      if (node.table) {
        const source = byTable.get(node.table)?.find((candidate) => !used.has(candidate));
        if (source) {
          used.add(source);
          apply(node, source);
        }
      }
      walk(node.children);
    }
  };
  walk(nodes);
}

export function explainFindings(nodes: ExplainNode[]): Finding[] {
  const findings: Finding[] = [];
  for (const node of nodes) {
    if (!node.table) continue;
    const rows = node.rows ?? 0;
    const runtimeRows = node.runtimeRows ?? 0;

    if (node.accessType === 'ALL') {
      addFinding(
        findings,
        'explain.full-table-scan',
        'Full table scan',
        rows > 1000 ? 'high' : 'medium',
        `MySQL plans to scan all rows of \`${node.table}\` (${rows.toLocaleString()} estimated).`,
        'Add a selective index for the WHERE/JOIN columns, or verify that a full scan is intentional.',
        node,
      );
    } else if (node.accessType === 'index' && rows > 1000) {
      addFinding(
        findings,
        'explain.full-index-scan',
        'Full index scan',
        'medium',
        `The plan reads the entire index for \`${node.table}\` (${rows.toLocaleString()} rows).`,
        'A more selective composite index can turn this into a range or ref access.',
        node,
      );
    }

    if (!node.key && node.possibleKeys.length > 0) {
      addFinding(
        findings,
        'explain.index-not-used',
        'Possible index not used',
        'medium',
        `Possible keys are available for \`${node.table}\` but the optimizer chose none: ${node.possibleKeys.join(', ')}.`,
        'Check for implicit casts, function-wrapped columns, or stale statistics (ANALYZE TABLE).',
        node,
      );
    }

    if (node.extra.some((flag) => flag.includes('using filesort'))) {
      addFinding(
        findings,
        'explain.filesort',
        'Filesort required',
        'medium',
        `Sorting for \`${node.table}\` requires an extra filesort pass.`,
        'Consider an index matching the ORDER BY columns, or reduce the sorted row count.',
        node,
      );
    }

    if (node.extra.some((flag) => flag.includes('using temporary'))) {
      addFinding(
        findings,
        'explain.temporary-table',
        'Temporary table required',
        'medium',
        'The plan materializes a temporary table, which can spill to disk.',
        'Simplify GROUP BY / DISTINCT / UNION, or add indexes that support the grouping order.',
        node,
      );
    }

    if (node.extra.some((flag) => flag.includes('using join buffer'))) {
      addFinding(
        findings,
        'explain.join-buffer',
        'Join without an index',
        'high',
        `The join for \`${node.table}\` uses a join buffer instead of an index lookup.`,
        'Add an index on the join columns of the joined table.',
        node,
      );
    }

    if (node.filtered != null && node.filtered < 10 && rows > 100) {
      addFinding(
        findings,
        'explain.low-filter',
        'Low filter selectivity',
        'medium',
        `Only about ${node.filtered.toFixed(1)}% of scanned rows survive the filter on \`${node.table}\`.`,
        'Add or extend an index so the storage engine can discard more rows before the server filter.',
        node,
      );
    }

    if (rows > 100_000) {
      addFinding(
        findings,
        'explain.high-row-count',
        'Very large row estimate',
        'high',
        `The plan estimates ${rows.toLocaleString()} rows for \`${node.table}\`.`,
        'Revisit the predicate and index design, and check that statistics are current.',
        node,
      );
    }

    // The plan ran (EXPLAIN ANALYZE): compare the estimate against the rows
    // that actually moved. An under-estimate is the classic stale-statistics
    // signal - the optimizer picks join orders and access paths from it - so
    // it reports a notch higher than the over-estimate direction.
    const actualPerLoop = actualRowsPerLoop(node);
    if (rows > 0 && actualPerLoop != null && actualPerLoop > DRIFT_MIN_ACTUAL_ROWS) {
      const driftAdvice =
        'Run ANALYZE TABLE on the table to refresh the optimizer statistics. On MySQL 8, histogram statistics (ANALYZE TABLE ... UPDATE HISTOGRAM ON <column> WITH 32 BUCKETS) help further for skewed column distributions.';
      if (actualPerLoop > rows * DRIFT_RATIO) {
        addFinding(
          findings,
          'explain.rows-estimate-drift',
          'Row estimate far below reality',
          'medium',
          `The optimizer estimated ${Math.round(rows).toLocaleString()} rows for \`${node.table}\`, but the plan actually processed about ${Math.round(actualPerLoop).toLocaleString()} per iteration.`,
          driftAdvice,
          node,
        );
      } else if (rows > actualPerLoop * DRIFT_RATIO) {
        addFinding(
          findings,
          'explain.rows-estimate-drift',
          'Row estimate far above reality',
          'low',
          `The optimizer estimated ${Math.round(rows).toLocaleString()} rows for \`${node.table}\`, but the plan actually processed about ${Math.round(actualPerLoop).toLocaleString()} per iteration.`,
          driftAdvice,
          node,
        );
      }
    }

    if (runtimeRows > 10_000) {
      addFinding(
        findings,
        'explain.slow-runtime',
        'Large runtime row count',
        'high',
        `The analyzed plan actually processed ${runtimeRows.toLocaleString()} rows for \`${node.table}\`.`,
        'Reduce the working set with a better index or a narrower predicate.',
        node,
      );
    }

    if ((node.runtimeMs ?? 0) > 1000) {
      addFinding(
        findings,
        'explain.slow-node',
        'Slow execution node',
        'high',
        `This node took ${(node.runtimeMs ?? 0).toFixed(1)} ms during EXPLAIN ANALYZE.`,
        'Focus optimization on this table access; inspect its index and filter.',
        node,
      );
    }
  }
  for (const node of nodes) {
    if (node.children.length) {
      const childFindings = explainFindings(node.children);
      for (const finding of childFindings) {
        if (
          !findings.some(
            (item) =>
              item.ruleId === finding.ruleId && item.object?.table === finding.object?.table,
          )
        ) {
          findings.push(finding);
        }
      }
    }
  }
  return findings;
}

function parseJsonColumn(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

export interface ExplainOptions {
  analyze?: boolean;
  /** Narrows a member session to their sandbox databases. */
  scopeOverride?: { allowed: string[] };
  /**
   * The user the request is made for. The write unlock belongs to one user, so
   * the check has to name them; without it only the profile-wide grant an
   * administrator holds applies.
   */
  userId?: string;
}

const parserModule = sqlParser as unknown as typeof import('node-sql-parser');
const sqlParserInstance = new parserModule.Parser();

/**
 * `EXPLAIN ... ${sql}` is built by string interpolation, so the statement is
 * parsed first and only a single SELECT/UNION (which node-sql-parser reports as
 * type `select`, including CTEs and set operations) may be appended. This runs
 * before any connection is acquired.
 */
export function assertExplainableStatement(sql: string): void {
  let parsed: unknown;
  try {
    parsed = sqlParserInstance.astify(sql, { database: 'MySQL' });
  } catch {
    throw new AppError(
      'EXPLAIN_PARSE_ERROR',
      'The statement could not be parsed. Explain accepts a single SELECT or UNION statement.',
      400,
    );
  }
  const nodes = Array.isArray(parsed) ? parsed : [parsed];
  if (nodes.length !== 1) {
    throw new AppError('MULTI_STATEMENT', 'Explain one statement at a time.', 400);
  }
  const node = nodes[0] as { type?: unknown } | null;
  const type = typeof node?.type === 'string' ? node.type.toLowerCase() : '';
  if (type !== 'select') {
    throw new AppError(
      'EXPLAIN_UNSUPPORTED',
      'Explain only accepts SELECT and UNION statements. Rewrite other statements as a SELECT, or run them normally.',
      400,
      { type: type || null },
    );
  }
}

export async function runExplain(
  profileId: string,
  sql: string,
  database: string | null,
  options: ExplainOptions = {},
): Promise<ExplainResult> {
  const classified = classifySql(sql);
  if (classified.empty) throw new AppError('EMPTY_SQL', 'There is no SQL to explain.', 400);
  if (classified.multiStatement) {
    throw new AppError('MULTI_STATEMENT', 'Explain one statement at a time.', 400, {
      classification: classified.overall,
    });
  }
  const classification = classified.overall;
  assertExplainableStatement(sql);
  // Resolve the default database so an unqualified statement cannot inherit the
  // database that a previous request left selected on this pooled connection.
  const profile = await getStoredProfile(profileId);
  const effectiveDatabase = database ?? profile.database ?? null;
  if (options.analyze && classification.needsUnlock) {
    // The policy decides whether this account may write at all; only then does
    // the in-memory grant decide.
    const writeAccess = await resolveWriteUnlock(profileId, options.userId);
    if (!writeAccess.allowed) {
      throw new AppError(
        'WRITE_LOCKED',
        writeAccess.blocker
          ? writeAccess.message
          : 'EXPLAIN ANALYZE executes the statement, and writes are locked.',
        403,
        { classification },
      );
    }
  }
  await assertSqlScope(profileId, sql, effectiveDatabase, options.scopeOverride);
  if (classification.needsUnlock && !effectiveDatabase) {
    throw new AppError(
      'DATABASE_REQUIRED',
      'EXPLAIN ANALYZE runs this statement, so it needs a database. Select one or set a default database on the connection.',
      400,
      { classification },
    );
  }

  const settings = await getSettings();
  const server = getCachedServerInfo(profileId) ?? (await connectProfile(profileId));
  const started = performance.now();

  return withConnection(
    profileId,
    async (conn) => {
      if (effectiveDatabase) await conn.query('USE ??', [effectiveDatabase]);
      const guards = await applyQueryGuards(conn, server, settings);
      try {
        let raw: unknown = null;
        let text: string | undefined;
        let analyzed = false;

        if (options.analyze) {
          analyzed = true;
          if (server.flavor === 'mariadb') {
            const [rows] = await conn.query<Row[]>(`ANALYZE FORMAT=JSON ${sql}`);
            raw = rows.length > 0 ? parseJsonColumn(Object.values(rows[0])[0]) : null;
          } else {
            const [jsonRows] = await conn.query<Row[]>(`EXPLAIN FORMAT=JSON ${sql}`);
            raw = jsonRows.length > 0 ? parseJsonColumn(Object.values(jsonRows[0])[0]) : null;
            try {
              const [textRows] = await conn.query<Row[]>(`EXPLAIN ANALYZE ${sql}`);
              text = textRows.map((row) => Object.values(row).map(String).join(' ')).join('\n');
            } catch {
              text = undefined;
            }
          }
        } else {
          const [rows] = await conn.query<Row[]>(`EXPLAIN FORMAT=JSON ${sql}`);
          raw = rows.length > 0 ? parseJsonColumn(Object.values(rows[0])[0]) : null;
        }

        // MySQL's EXPLAIN FORMAT=JSON holds the estimates; the EXPLAIN ANALYZE
        // tree holds the runtimes, which MariaDB already embeds as r_* fields.
        // When the JSON plan is unreadable, the tree alone still yields nodes.
        const nodes = raw ? visit(raw) : [];
        if (text) {
          const tree = parseExplainAnalyzeTree(text);
          if (nodes.length > 0) mergeAnalyzeRuntime(nodes, tree);
          else nodes.push(...tree);
        }
        const findings = explainFindings(nodes);
        return {
          sql,
          analyzed,
          format: raw ? 'json' : 'text',
          nodes,
          insights: findings,
          suggestions: [],
          raw: raw ?? text ?? null,
          text,
          totalCost: raw ? findTotalCost(raw) : null,
          executionMs: Math.round(performance.now() - started),
        } satisfies ExplainResult;
      } finally {
        await guards.cleanup();
      }
    },
    // EXPLAIN ANALYZE of a write statement can open a transaction.
    { rollbackOnRelease: classification.needsUnlock },
  );
}
