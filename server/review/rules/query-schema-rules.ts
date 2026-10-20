import type {
  ColumnInfo,
  Finding,
  IndexInfo,
  SchemaTable,
} from '../../../shared/types';
import { createFinding } from '../findings';
import type { RuleContext } from './types';

type AnyRecord = Record<string, unknown>;

const NUMERIC_TYPES = new Set([
  'int',
  'integer',
  'tinyint',
  'smallint',
  'mediumint',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'double',
  'real',
  'bit',
]);
const STRING_TYPES = new Set([
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'enum',
  'set',
  'json',
]);
const TEMPORAL_TYPES = new Set(['date', 'datetime', 'timestamp', 'time', 'year']);
const INDEX_BREAKING_FUNCTIONS = new Set([
  'DATE',
  'YEAR',
  'MONTH',
  'DAY',
  'DAYOFMONTH',
  'HOUR',
  'MINUTE',
  'SECOND',
  'LOWER',
  'UPPER',
  'TRIM',
  'LTRIM',
  'RTRIM',
  'SUBSTRING',
  'SUBSTR',
  'LEFT',
  'RIGHT',
  'CONCAT',
  'CAST',
  'CONVERT',
  'ABS',
  'ROUND',
  'FLOOR',
  'CEIL',
  'CEILING',
  'UNIX_TIMESTAMP',
  'FROM_UNIXTIME',
  'MD5',
  'SHA1',
  'SHA2',
  'LENGTH',
  'CHAR_LENGTH',
  'JSON_EXTRACT',
  'JSON_UNQUOTE',
]);

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function walk(node: unknown, fn: (node: AnyRecord) => void): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, fn);
    return;
  }
  if (!isRecord(node)) return;
  fn(node);
  for (const value of Object.values(node)) walk(value, fn);
}

function literalKind(node: unknown): 'string' | 'number' | 'null' | 'other' {
  if (!isRecord(node)) return 'other';
  const type = String(node.type ?? '');
  if (['string', 'single_quote_string', 'double_quote_string'].includes(type)) return 'string';
  if (type === 'number') return 'number';
  if (type === 'null') return 'null';
  return 'other';
}

function literalValue(node: unknown): string | number | null {
  if (!isRecord(node)) return null;
  const type = String(node.type ?? '');
  if (['string', 'single_quote_string', 'double_quote_string'].includes(type)) {
    return String(node.value ?? '');
  }
  if (type === 'number') {
    const parsed = Number(node.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isNumeric(column: ColumnInfo): boolean {
  return NUMERIC_TYPES.has(column.dataType);
}
function isString(column: ColumnInfo): boolean {
  return STRING_TYPES.has(column.dataType);
}
function isTemporal(column: ColumnInfo): boolean {
  return TEMPORAL_TYPES.has(column.dataType);
}

function functionName(node: AnyRecord): string {
  const name = node.name;
  if (typeof name === 'string') return name.toUpperCase();
  if (isRecord(name) && Array.isArray(name.name)) {
    return name.name
      .map((part) => (isRecord(part) ? String(part.value ?? '') : ''))
      .join('')
      .toUpperCase();
  }
  return '';
}

function resolveRef(
  context: RuleContext,
  ref: { table: string | null; column: string },
): { table: SchemaTable; column: ColumnInfo } | 'unknown' | 'ambiguous' | null {
  if (!context.schema || context.tables.length === 0) return null;
  if (ref.column === '*') return null;

  const findColumn = (table: SchemaTable): ColumnInfo | null =>
    table.columns.find((column) => column.name.toLowerCase() === ref.column.toLowerCase()) ?? null;

  if (ref.table) {
    const table = context.tableLookup.get(ref.table.toLowerCase());
    if (!table) return null;
    const column = findColumn(table);
    if (!column) return 'unknown';
    return { table, column };
  }

  if (context.tables.length === 1) {
    const column = findColumn(context.tables[0]);
    return column ? { table: context.tables[0], column } : 'unknown';
  }

  const matches = context.tables
    .map((table) => ({ table, column: findColumn(table) }))
    .filter((item): item is { table: SchemaTable; column: ColumnInfo } => Boolean(item.column));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return 'ambiguous';
  return 'unknown';
}

function leadingIndex(table: SchemaTable, column: string): IndexInfo | null {
  return (
    table.indexes.find(
      (index) =>
        index.columns.length > 0 &&
        index.columns[0].name.toLowerCase() === column.toLowerCase(),
    ) ?? null
  );
}

function lineFor(context: RuleContext, name: string, fallback: number): number {
  const token = context.tokens.find(
    (item) => item.kind === 'word' && item.value.toLowerCase() === name.toLowerCase(),
  );
  return token?.line ?? fallback;
}

function tableForEntry(
  context: RuleContext,
  entry: AnyRecord,
): SchemaTable | null {
  if (typeof entry.table !== 'string') return null;
  return context.tableLookup.get(entry.table.toLowerCase()) ?? null;
}

export function runQuerySchemaRules(context: RuleContext): Finding[] {
  if (!context.schema) return [];
  const findings: Finding[] = [];
  const seen = new Set<string>();

  const add = (finding: Finding): void => {
    const key = `${finding.ruleId}|${finding.object?.table ?? ''}|${finding.object?.column ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (let statementIndex = 0; statementIndex < context.asts.length; statementIndex += 1) {
    const ast = context.asts[statementIndex];
    if (!isRecord(ast)) continue;
    const statement = context.statements[statementIndex];
    const fallbackLine = statement?.line ?? 1;

    // Unknown / ambiguous columns
    walk(ast, (node) => {
      if (node.type !== 'column_ref' || typeof node.column !== 'string') return;
      if (node.column === '*') return;
      const resolved = resolveRef(context, {
        table: node.table == null ? null : String(node.table),
        column: node.column,
      });
      if (resolved === 'unknown') {
        add(
          createFinding({
            ruleId: 'sql.unknown-column',
            title: 'Column not found in the referenced table',
            severity: 'medium',
            category: 'correctness',
            message: `Column \`${node.column}\` was not found in the schema context.`,
            recommendation: 'Verify the column name, alias, and selected database.',
            line: lineFor(context, node.column, fallbackLine),
            object: node.table ? { table: String(node.table), column: String(node.column) } : { column: String(node.column) },
            confidence: 'medium',
          }),
        );
      } else if (resolved === 'ambiguous') {
        add(
          createFinding({
            ruleId: 'sql.ambiguous-column',
            title: 'Ambiguous unqualified column',
            severity: 'high',
            category: 'correctness',
            message: `Column \`${node.column}\` exists in more than one referenced table. MySQL will reject the query as ambiguous.`,
            recommendation: 'Qualify the column with its table or alias.',
            line: lineFor(context, node.column, fallbackLine),
            object: { column: String(node.column) },
            confidence: 'high',
          }),
        );
      }
    });

    // Implicit casts, LIKE on numeric columns, NOT IN with nullable columns
    walk(ast, (node) => {
      if (node.type !== 'binary_expr') return;
      const operator = String(node.operator ?? '').toUpperCase();

      if (['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE'].includes(operator)) {
        const sides = [
          { expr: node.left, other: node.right },
          { expr: node.right, other: node.left },
        ];
        for (const side of sides) {
          if (!isRecord(side.expr) || side.expr.type !== 'column_ref') continue;
          const resolved = resolveRef(context, {
            table: side.expr.table == null ? null : String(side.expr.table),
            column: String(side.expr.column ?? ''),
          });
          if (!resolved || typeof resolved === 'string') continue;
          const kind = literalKind(side.other);
          if (kind === 'other') continue;

          if (isString(resolved.column) && kind === 'number') {
            add(
              createFinding({
                ruleId: 'sql.implicit-cast',
                title: 'Numeric literal compared to a text column',
                severity: 'medium',
                category: 'performance',
                message: `\`${resolved.table.name}\`.\`${resolved.column.name}\` is ${resolved.column.dataType}, but the predicate compares it to a number. MySQL may convert every row before comparing.`,
                recommendation: 'Pass the value as a string, or change the column type if it stores numbers.',
                line: lineFor(context, resolved.column.name, fallbackLine),
                object: {
                  table: resolved.table.name,
                  column: resolved.column.name,
                },
                confidence: 'medium',
              }),
            );
          } else if (
            (isNumeric(resolved.column) || isTemporal(resolved.column)) &&
            kind === 'string'
          ) {
            add(
              createFinding({
                ruleId: 'sql.implicit-cast-literal',
                title: 'String literal compared to a non-text column',
                severity: 'low',
                category: 'correctness',
                message: `The predicate supplies a string for ${resolved.column.dataType} column \`${resolved.column.name}\`. MySQL will coerce it and may hide invalid values.`,
                recommendation: 'Use a typed value or a date/number literal in the correct format.',
                line: lineFor(context, resolved.column.name, fallbackLine),
                object: {
                  table: resolved.table.name,
                  column: resolved.column.name,
                },
                confidence: 'medium',
              }),
            );
          }

          if (operator.includes('LIKE') && isNumeric(resolved.column)) {
            add(
              createFinding({
                ruleId: 'sql.like-numeric-column',
                title: 'LIKE on a numeric column',
                severity: 'medium',
                category: 'performance',
                message: 'LIKE forces MySQL to convert the numeric column to text, which prevents index use.',
                recommendation: 'Use numeric comparison operators, or change the column type if it stores text.',
                line: lineFor(context, resolved.column.name, fallbackLine),
                object: {
                  table: resolved.table.name,
                  column: resolved.column.name,
                },
              }),
            );
          }

          if (operator === 'LIKE') {
            const pattern = literalValue(side.other);
            if (
              typeof pattern === 'string' &&
              (pattern.startsWith('%') || pattern.startsWith('_'))
            ) {
              const index = leadingIndex(resolved.table, resolved.column.name);
              if (index) {
                add(
                  createFinding({
                    ruleId: 'sql.leading-wildcard-indexed',
                    title: 'Leading wildcard defeats the index',
                    severity: 'medium',
                    category: 'performance',
                    message: `The index \`${index.name}\` on \`${resolved.table.name}\` cannot serve this leading-wildcard LIKE.`,
                    recommendation: 'Use a prefix pattern or a FULLTEXT index for contains-style search.',
                    line: lineFor(context, resolved.column.name, fallbackLine),
                    object: {
                      table: resolved.table.name,
                      column: resolved.column.name,
                      index: index.name,
                    },
                  }),
                );
              }
            }
          }
        }
      }

      if (['NOT IN', 'NOT_IN'].includes(operator)) {
        if (isRecord(node.left) && node.left.type === 'column_ref') {
          const resolved = resolveRef(context, {
            table: node.left.table == null ? null : String(node.left.table),
            column: String(node.left.column ?? ''),
          });
          if (resolved && typeof resolved !== 'string' && resolved.column.nullable) {
            add(
              createFinding({
                ruleId: 'sql.not-in-nullable',
                title: 'NOT IN over a nullable column',
                severity: 'medium',
                category: 'correctness',
                message: `\`${resolved.column.name}\` is nullable; if any compared value is NULL, NOT IN returns no rows.`,
                recommendation: 'Use NOT EXISTS, or add IS NOT NULL and verify the data.',
                line: lineFor(context, resolved.column.name, fallbackLine),
                object: {
                  table: resolved.table.name,
                  column: resolved.column.name,
                },
              }),
            );
          }
        }
      }
    });

    // Functions wrapped around indexed columns
    walk(ast, (node) => {
      if (node.type !== 'function') return;
      const name = functionName(node);
      if (!INDEX_BREAKING_FUNCTIONS.has(name)) return;
      const args = node.args;
      const refs: { table: string | null; column: string }[] = [];
      walk(args, (arg) => {
        if (arg.type === 'column_ref' && typeof arg.column === 'string') {
          refs.push({
            table: arg.table == null ? null : String(arg.table),
            column: arg.column,
          });
        }
      });
      for (const ref of refs) {
        const resolved = resolveRef(context, ref);
        if (!resolved || typeof resolved === 'string') continue;
        const index = leadingIndex(resolved.table, resolved.column.name);
        if (!index) continue;
        add(
          createFinding({
            ruleId: 'sql.function-on-indexed-column',
            title: 'Function wrapped around an indexed column',
            severity: 'medium',
            category: 'performance',
            message: `${name}() wraps \`${resolved.column.name}\`, so MySQL cannot use index \`${index.name}\` directly.`,
            recommendation: 'Rewrite as a range predicate, or add a functional/generated-column index.',
            line: lineFor(context, resolved.column.name, fallbackLine),
            object: {
              table: resolved.table.name,
              column: resolved.column.name,
              index: index.name,
            },
          }),
        );
      }
    });

    // UPDATE/DELETE target without a primary key
    if (ast.type === 'update' || ast.type === 'delete') {
      const tables = Array.isArray(ast.table) ? ast.table : [];
      for (const entry of tables) {
        if (!isRecord(entry)) continue;
        const table = tableForEntry(context, entry);
        if (!table) continue;
        const hasPrimary = table.indexes.some(
          (index) => index.name.toUpperCase() === 'PRIMARY',
        );
        if (!hasPrimary) {
          add(
            createFinding({
              ruleId: 'sql.no-primary-key-target',
              title: 'Writing to a table without a primary key',
              severity: 'high',
              category: 'schema',
              message: `\`${table.name}\` has no PRIMARY KEY. Row-by-row updates/deletes are harder to make safe and replicate efficiently.`,
              recommendation: 'Add a primary key, and include it in the WHERE clause for targeted changes.',
              line: fallbackLine,
              object: { database: table.database, table: table.name },
            }),
          );
        }
      }
    }

    // Join indexes and type mismatches
    if (ast.type === 'select' && Array.isArray(ast.from)) {
      for (const entry of ast.from) {
        if (!isRecord(entry) || !entry.join || !isRecord(entry.on)) continue;
        const joinedTable = tableForEntry(context, entry);
        if (!joinedTable) continue;

        const conditions: AnyRecord[] = [];
        const collectEquals = (node: unknown): void => {
          if (!isRecord(node)) return;
          if (
            node.type === 'binary_expr' &&
            String(node.operator).toUpperCase() === '='
          ) {
            conditions.push(node);
          }
          if (node.type === 'binary_expr') {
            collectEquals(node.left);
            collectEquals(node.right);
          }
        };
        collectEquals(entry.on);

        for (const condition of conditions) {
          const left = condition.left;
          const right = condition.right;
          if (
            !isRecord(left) ||
            !isRecord(right) ||
            left.type !== 'column_ref' ||
            right.type !== 'column_ref'
          ) {
            continue;
          }
          const leftResolved = resolveRef(context, {
            table: left.table == null ? null : String(left.table),
            column: String(left.column ?? ''),
          });
          const rightResolved = resolveRef(context, {
            table: right.table == null ? null : String(right.table),
            column: String(right.column ?? ''),
          });
          if (
            !leftResolved ||
            !rightResolved ||
            typeof leftResolved === 'string' ||
            typeof rightResolved === 'string'
          ) {
            continue;
          }

          if (
            (isNumeric(leftResolved.column) && isString(rightResolved.column)) ||
            (isString(leftResolved.column) && isNumeric(rightResolved.column))
          ) {
            add(
              createFinding({
                ruleId: 'sql.join-type-mismatch',
                title: 'Join columns have different types',
                severity: 'high',
                category: 'performance',
                message: `Joining ${leftResolved.table.name}.${leftResolved.column.name} (${leftResolved.column.dataType}) to ${rightResolved.table.name}.${rightResolved.column.name} (${rightResolved.column.dataType}) forces a conversion on one side.`,
                recommendation: 'Use matching data types for join keys, or add a generated/cast column if the schema cannot change.',
                line: fallbackLine,
                object: {
                  table: leftResolved.table.name,
                  column: leftResolved.column.name,
                },
              }),
            );
          }

          const joinedSide =
            leftResolved.table.name === joinedTable.name &&
            leftResolved.column.name
              ? leftResolved
              : rightResolved.table.name === joinedTable.name
                ? rightResolved
                : null;
          if (joinedSide) {
            const index = leadingIndex(joinedSide.table, joinedSide.column.name);
            if (!index) {
              add(
                createFinding({
                  ruleId: 'sql.join-without-index',
                  title: 'Join column is not indexed',
                  severity: 'medium',
                  category: 'performance',
                  message: `\`${joinedSide.table.name}\`.\`${joinedSide.column.name}\` is used as a join key but is not the leading column of an index.`,
                  recommendation: 'Add an index on the join column, or extend an existing index so it starts with that column.',
                  line: fallbackLine,
                  object: {
                    table: joinedSide.table.name,
                    column: joinedSide.column.name,
                  },
                }),
              );
            }
          }
        }
      }
    }
  }

  return findings;
}
