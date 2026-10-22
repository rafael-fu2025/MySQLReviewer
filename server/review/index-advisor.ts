import type { IndexSuggestion, SchemaTable } from '../../shared/types';
import type { RuleContext } from './rules/types';
import { isRecord, walk } from './ast-utils';

interface Candidate {
  equality: string[];
  range: string[];
  order: string[];
}

function addUnique(list: string[], value: string): void {
  const lower = value.toLowerCase();
  if (!list.some((item) => item.toLowerCase() === lower)) list.push(value);
}

function resolveRef(
  context: RuleContext,
  ref: { table: string | null; column: string },
): { table: SchemaTable; column: string } | null {
  if (!context.schema || ref.column === '*') return null;
  const find = (table: SchemaTable): string | null => {
    const column = table.columns.find(
      (item) => item.name.toLowerCase() === ref.column.toLowerCase(),
    );
    return column?.name ?? null;
  };
  if (ref.table) {
    const table = context.tableLookup.get(ref.table.toLowerCase());
    if (!table) return null;
    const column = find(table);
    return column ? { table, column } : null;
  }
  if (context.tables.length === 1) {
    const column = find(context.tables[0]);
    return column ? { table: context.tables[0], column } : null;
  }
  const matches = context.tables
    .map((table) => ({ table, column: find(table) }))
    .filter((item): item is { table: SchemaTable; column: string } => Boolean(item.column));
  return matches.length === 1 ? matches[0] : null;
}

function refOf(node: unknown): { table: string | null; column: string } | null {
  if (!isRecord(node) || node.type !== 'column_ref' || typeof node.column !== 'string') {
    return null;
  }
  return {
    table: node.table == null ? null : String(node.table),
    column: node.column,
  };
}

function literalLike(node: unknown): boolean {
  if (!isRecord(node)) return false;
  return [
    'string',
    'single_quote_string',
    'double_quote_string',
    'number',
    'null',
    'bool',
    'origin',
  ].includes(String(node.type ?? ''));
}

function candidateFor(
  map: Map<string, { table: SchemaTable; candidate: Candidate }>,
  table: SchemaTable,
): Candidate {
  const key = `${table.database}.${table.name}`;
  let entry = map.get(key);
  if (!entry) {
    entry = {
      table,
      candidate: { equality: [], range: [], order: [] },
    };
    map.set(key, entry);
  }
  return entry.candidate;
}

function collectPredicates(
  context: RuleContext,
  node: unknown,
  map: Map<string, { table: SchemaTable; candidate: Candidate }>,
): void {
  walk(node, (current) => {
    if (current.type !== 'binary_expr' && current.type !== 'like') return;
    const operator = String(current.operator ?? '').toUpperCase();
    const leftRef = refOf(current.left);
    const rightRef = refOf(current.right);

    if (operator === '=' || operator === '<=>') {
      if (leftRef && rightRef) {
        const left = resolveRef(context, leftRef);
        const right = resolveRef(context, rightRef);
        if (left) addUnique(candidateFor(map, left.table).equality, left.column);
        if (right) addUnique(candidateFor(map, right.table).equality, right.column);
      } else if (leftRef && literalLike(current.right)) {
        const resolved = resolveRef(context, leftRef);
        if (resolved) addUnique(candidateFor(map, resolved.table).equality, resolved.column);
      } else if (rightRef && literalLike(current.left)) {
        const resolved = resolveRef(context, rightRef);
        if (resolved) addUnique(candidateFor(map, resolved.table).equality, resolved.column);
      }
      return;
    }

    if (operator === 'IN') {
      if (leftRef) {
        const resolved = resolveRef(context, leftRef);
        if (resolved) addUnique(candidateFor(map, resolved.table).equality, resolved.column);
      }
      return;
    }

    if (['>', '>=', '<', '<=', 'BETWEEN', 'LIKE'].includes(operator)) {
      if (!leftRef) return;
      const resolved = resolveRef(context, leftRef);
      if (!resolved) return;
      if (operator === 'LIKE') {
        const pattern =
          isRecord(current.right) && typeof current.right.value === 'string'
            ? current.right.value
            : null;
        if (pattern && (pattern.startsWith('%') || pattern.startsWith('_'))) return;
      }
      addUnique(candidateFor(map, resolved.table).range, resolved.column);
    }
  });
}

function existingIndexCovers(table: SchemaTable, columns: string[]): boolean {
  const lower = columns.map((column) => column.toLowerCase());
  return table.indexes.some((index) => {
    if (index.columns.length < lower.length) return false;
    return lower.every((column, i) => index.columns[i].name.toLowerCase() === column);
  });
}

function ident(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

export function suggestIndexes(context: RuleContext): IndexSuggestion[] {
  if (!context.schema || context.tables.length === 0) return [];
  const map = new Map<string, { table: SchemaTable; candidate: Candidate }>();

  for (const ast of context.asts) {
    if (!isRecord(ast)) continue;
    collectPredicates(context, ast.where, map);

    if (Array.isArray(ast.from)) {
      for (const entry of ast.from) {
        if (isRecord(entry)) collectPredicates(context, entry.on, map);
      }
    }

    if (isRecord(ast.groupby) && Array.isArray(ast.groupby.columns)) {
      for (const groupColumn of ast.groupby.columns) {
        const refs: { table: string | null; column: string }[] = [];
        walk(groupColumn, (current) => {
          const ref = refOf(current);
          if (ref) refs.push(ref);
        });
        for (const ref of refs) {
          const resolved = resolveRef(context, ref);
          if (resolved) addUnique(candidateFor(map, resolved.table).order, resolved.column);
        }
      }
    }

    const orderBy = Array.isArray(ast.orderby) ? ast.orderby : [];
    for (const order of orderBy) {
      if (!isRecord(order)) continue;
      const refs: { table: string | null; column: string }[] = [];
      walk(order.expr, (current) => {
        const ref = refOf(current);
        if (ref) refs.push(ref);
      });
      for (const ref of refs) {
        const resolved = resolveRef(context, ref);
        if (resolved) addUnique(candidateFor(map, resolved.table).order, resolved.column);
      }
    }
  }

  const suggestions: IndexSuggestion[] = [];
  for (const { table, candidate } of map.values()) {
    const columns = [
      ...candidate.equality.slice(0, 3),
      ...candidate.range.slice(0, 1),
      ...candidate.order
        .filter(
          (column) =>
            !candidate.equality.some((item) => item.toLowerCase() === column.toLowerCase()) &&
            !candidate.range.some((item) => item.toLowerCase() === column.toLowerCase()),
        )
        .slice(0, 2),
    ];
    if (columns.length === 0) continue;
    if (existingIndexCovers(table, columns)) continue;

    const reasonParts: string[] = [];
    if (candidate.equality.length > 0) {
      reasonParts.push(`equality on ${candidate.equality.slice(0, 3).join(', ')}`);
    }
    if (candidate.range.length > 0) {
      reasonParts.push(`range on ${candidate.range[0]}`);
    }
    if (candidate.order.length > 0) {
      reasonParts.push(`ordering/grouping on ${candidate.order.slice(0, 2).join(', ')}`);
    }

    const confidence: IndexSuggestion['confidence'] =
      candidate.equality.length > 0
        ? table.rowsEstimate > 1000
          ? 'high'
          : 'medium'
        : candidate.range.length > 0
          ? 'medium'
          : 'low';

    const indexName = `idx_${table.name}_${columns.join('_')}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 64);

    suggestions.push({
      database: table.database,
      table: table.name,
      columns,
      reason: `Candidate index derived from ${reasonParts.join('; ')}. Estimated rows: ${table.rowsEstimate.toLocaleString()}.`,
      statement: `ALTER TABLE ${ident(table.database)}.${ident(table.name)} ADD INDEX ${ident(indexName)} (${columns.map(ident).join(', ')});`,
      confidence,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return suggestions
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.table.localeCompare(b.table))
    .slice(0, 6);
}
