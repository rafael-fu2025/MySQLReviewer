import crypto from 'node:crypto';
import sqlParser from 'node-sql-parser';
import type { RowDataPacket } from 'mysql2/promise';
import type { ExplainNode, ExplainResult, Finding } from '../../shared/types';
import { AppError } from '../errors';
import { getSettings } from '../store/settings';
import { getStoredProfile } from '../store/profiles';
import { classifySql } from '../review/sql-classifier';
import {
  connectProfile,
  getCachedServerInfo,
  isWritesUnlocked,
  withConnection,
} from './manager';
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
    asNumber(costInfo.prefix_cost) ??
    asNumber(costInfo.read_cost) ??
    asNumber(value.cost);

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

function addFinding(
  findings: Finding[],
  ruleId: string,
  title: string,
  severity: Finding['severity'],
  message: string,
  recommendation: string,
  node: ExplainNode,
): void {
  if (findings.some((finding) => finding.ruleId === ruleId && finding.object?.table === node.table)) {
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
        if (!findings.some((item) => item.ruleId === finding.ruleId && item.object?.table === finding.object?.table)) {
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
    throw new AppError(
      'MULTI_STATEMENT',
      'Explain one statement at a time.',
      400,
      { classification: classified.overall },
    );
  }
  const classification = classified.overall;
  assertExplainableStatement(sql);
  // Resolve the default database so an unqualified statement cannot inherit the
  // database that a previous request left selected on this pooled connection.
  const profile = await getStoredProfile(profileId);
  const effectiveDatabase = database ?? profile.database ?? null;
  if (options.analyze && classification.needsUnlock && !isWritesUnlocked(profileId)) {
    throw new AppError(
      'WRITE_LOCKED',
      'EXPLAIN ANALYZE executes the statement, and writes are locked.',
      403,
      { classification },
    );
  }
  await assertSqlScope(profileId, sql, effectiveDatabase);
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
            const [rows] = await conn.query<Row[]>(
              `ANALYZE FORMAT=JSON ${sql}`,
            );
            raw = rows.length > 0 ? parseJsonColumn(Object.values(rows[0])[0]) : null;
          } else {
            const [jsonRows] = await conn.query<Row[]>(
              `EXPLAIN FORMAT=JSON ${sql}`,
            );
            raw = jsonRows.length > 0
              ? parseJsonColumn(Object.values(jsonRows[0])[0])
              : null;
            try {
              const [textRows] = await conn.query<Row[]>(`EXPLAIN ANALYZE ${sql}`);
              text = textRows
                .map((row) => Object.values(row).map(String).join(' '))
                .join('\n');
            } catch {
              text = undefined;
            }
          }
        } else {
          const [rows] = await conn.query<Row[]>(`EXPLAIN FORMAT=JSON ${sql}`);
          raw = rows.length > 0 ? parseJsonColumn(Object.values(rows[0])[0]) : null;
        }

        const nodes = raw ? visit(raw) : [];
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
