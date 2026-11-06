/**
 * Shared helpers for working with the `node-sql-parser` AST.
 *
 * These were previously copy-pasted across the rule modules; keeping one
 * implementation means a fix to the walker applies everywhere.
 */

export type AnyRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Depth-first walk over every object node in the AST. */
export function walk(node: unknown, fn: (node: AnyRecord) => void): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, fn);
    return;
  }
  if (!isRecord(node)) return;
  fn(node);
  for (const value of Object.values(node)) walk(value, fn);
}

/** The `type` discriminator of an AST node, or an empty string. */
export function astType(ast: unknown): string {
  return isRecord(ast) && typeof ast.type === 'string' ? ast.type : '';
}

const STRING_LITERAL_TYPES = ['string', 'single_quote_string', 'double_quote_string'];

export function stringValue(node: unknown): string | null {
  if (!isRecord(node)) return null;
  if (STRING_LITERAL_TYPES.includes(String(node.type ?? ''))) {
    return String(node.value ?? '');
  }
  return null;
}

export function numberValue(node: unknown): number | null {
  if (!isRecord(node)) return null;
  if (node.type === 'number') {
    const parsed = Number(node.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function literalKind(node: unknown): 'string' | 'number' | 'null' | 'other' {
  if (!isRecord(node)) return 'other';
  const type = String(node.type ?? '');
  if (STRING_LITERAL_TYPES.includes(type)) return 'string';
  if (type === 'number') return 'number';
  if (type === 'null') return 'null';
  return 'other';
}

export function literalValue(node: unknown): string | number | null {
  if (!isRecord(node)) return null;
  const type = String(node.type ?? '');
  if (STRING_LITERAL_TYPES.includes(type)) return String(node.value ?? '');
  if (type === 'number') {
    const parsed = Number(node.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The unqualified function name of a `function` node. */
export function functionName(node: AnyRecord): string {
  const name = node.name;
  if (typeof name === 'string') return name;
  if (isRecord(name) && Array.isArray(name.name)) {
    return name.name.map((part) => (isRecord(part) ? String(part.value ?? '') : '')).join('');
  }
  return '';
}

export interface ColumnRef {
  table: string | null;
  column: string;
}

/** Every `column_ref` in the subtree. */
export function collectColumnRefs(node: unknown): ColumnRef[] {
  const refs: ColumnRef[] = [];
  walk(node, (current) => {
    if (current.type === 'column_ref' && typeof current.column === 'string') {
      refs.push({
        table: current.table == null ? null : String(current.table),
        column: current.column,
      });
    }
  });
  return refs;
}

/** True when the subtree contains an aggregate function call. */
export function hasAggregate(node: unknown): boolean {
  let found = false;
  walk(node, (current) => {
    if (current.type === 'aggr_func') found = true;
  });
  return found;
}

/** The `FROM` entries of a statement, in source order. */
export function fromEntries(ast: unknown): AnyRecord[] {
  if (!isRecord(ast) || !Array.isArray(ast.from)) return [];
  return ast.from.filter(isRecord);
}

/**
 * Every table a statement refers to, in source order.
 *
 * `node-sql-parser` keeps the table of a statement in different places:
 * SELECT/DELETE use `from`, UPDATE/INSERT/ALTER use `table`, and
 * DROP/TRUNCATE use `name`. Reading only `from` loses the table identity for
 * every statement that is not a plain SELECT or DELETE.
 */
export function tableEntries(ast: unknown): AnyRecord[] {
  if (!isRecord(ast)) return [];
  const entries: AnyRecord[] = [];
  for (const key of ['from', 'table', 'name'] as const) {
    const value = ast[key];
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      // `name` also carries non-table identifiers (e.g. the index name of
      // `DROP INDEX`), so only entries that name a table are kept.
      if (isRecord(item) && typeof item.table === 'string') entries.push(item);
    }
  }
  return entries;
}

/** The first table a statement refers to, or `null` when it names none. */
export function primaryTable(ast: unknown): string | null {
  for (const entry of tableEntries(ast)) {
    if (entry.table) return String(entry.table);
  }
  return null;
}

/** The selected columns of a statement, in source order. */
export function selectedColumns(ast: unknown): AnyRecord[] {
  if (!isRecord(ast) || !Array.isArray(ast.columns)) return [];
  return ast.columns.filter(isRecord);
}

export function isStarColumn(column: AnyRecord): boolean {
  const expr = column.expr;
  if (!isRecord(expr)) return false;
  if (expr.type === 'star') return true;
  return expr.type === 'column_ref' && String(expr.column ?? '') === '*';
}

/** True when the subtree contains a nested `select`. */
export function hasSubquery(node: unknown): boolean {
  let found = false;
  walk(node, (current) => {
    if (current.type === 'select' && current !== node) found = true;
  });
  return found;
}
