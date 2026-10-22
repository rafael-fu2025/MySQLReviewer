import type { ColumnInfo, IndexInfo, SchemaTable } from '../../../shared/types';
import {
  functionName,
  isRecord,
  literalKind,
  literalValue,
  walk,
  type AnyRecord,
} from '../ast-utils';
import { defineRule, runRules, type Rule } from './descriptor';
import type { RuleContext } from './types';

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

function isNumeric(column: ColumnInfo): boolean {
  return NUMERIC_TYPES.has(column.dataType);
}
function isString(column: ColumnInfo): boolean {
  return STRING_TYPES.has(column.dataType);
}
function isTemporal(column: ColumnInfo): boolean {
  return TEMPORAL_TYPES.has(column.dataType);
}

type Resolution = { table: SchemaTable; column: ColumnInfo } | 'unknown' | 'ambiguous' | null;

function resolveRef(
  context: RuleContext,
  ref: { table: string | null; column: string },
): Resolution {
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
        index.columns.length > 0 && index.columns[0].name.toLowerCase() === column.toLowerCase(),
    ) ?? null
  );
}

function lineFor(context: RuleContext, name: string, fallback: number): number {
  const token = context.tokens.find(
    (item) => item.kind === 'word' && item.value.toLowerCase() === name.toLowerCase(),
  );
  return token?.line ?? fallback;
}

function tableForEntry(context: RuleContext, entry: AnyRecord): SchemaTable | null {
  if (typeof entry.table !== 'string') return null;
  return context.tableLookup.get(entry.table.toLowerCase()) ?? null;
}

export interface QuerySchemaRuleInput {
  context: RuleContext;
  ast: AnyRecord;
  fallbackLine: number;
}

/** A resolved column reference together with the side of the comparison it came from. */
interface ComparisonSide {
  expr: unknown;
  other: unknown;
}

function comparisonSides(node: AnyRecord): ComparisonSide[] {
  return [
    { expr: node.left, other: node.right },
    { expr: node.right, other: node.left },
  ];
}

export const QUERY_SCHEMA_RULES: Rule<QuerySchemaRuleInput>[] = [
  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.unknown-column',
      title: 'Column not found in the referenced table',
      severity: 'medium',
      category: 'correctness',
    },
    ({ context, ast, fallbackLine }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table?: string; column: string };
        confidence: 'medium';
      }> = [];
      walk(ast, (node) => {
        if (node.type !== 'column_ref' || typeof node.column !== 'string') return;
        if (node.column === '*') return;
        const resolved = resolveRef(context, {
          table: node.table == null ? null : String(node.table),
          column: node.column,
        });
        if (resolved !== 'unknown') return;
        hits.push({
          message: `Column \`${node.column}\` was not found in the schema context.`,
          recommendation: 'Verify the column name, alias, and selected database.',
          line: lineFor(context, node.column, fallbackLine),
          object: node.table
            ? { table: String(node.table), column: String(node.column) }
            : { column: String(node.column) },
          confidence: 'medium',
        });
      });
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.ambiguous-column',
      title: 'Ambiguous unqualified column',
      severity: 'high',
      category: 'correctness',
    },
    ({ context, ast, fallbackLine }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { column: string };
        confidence: 'high';
      }> = [];
      walk(ast, (node) => {
        if (node.type !== 'column_ref' || typeof node.column !== 'string') return;
        if (node.column === '*') return;
        const resolved = resolveRef(context, {
          table: node.table == null ? null : String(node.table),
          column: node.column,
        });
        if (resolved !== 'ambiguous') return;
        hits.push({
          message: `Column \`${node.column}\` exists in more than one referenced table. MySQL will reject the query as ambiguous.`,
          recommendation: 'Qualify the column with its table or alias.',
          line: lineFor(context, node.column, fallbackLine),
          object: { column: String(node.column) },
          confidence: 'high',
        });
      });
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.implicit-cast',
      title: 'Numeric literal compared to a text column',
      severity: 'medium',
      category: 'performance',
    },
    ({ context, ast, fallbackLine }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table: string; column: string };
        confidence: 'medium';
      }> = [];
      walk(ast, (node) => {
        if (node.type !== 'binary_expr') return;
        const operator = String(node.operator ?? '').toUpperCase();
        if (!['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE'].includes(operator)) {
          return;
        }
        for (const side of comparisonSides(node)) {
          if (!isRecord(side.expr) || side.expr.type !== 'column_ref') continue;
          const resolved = resolveRef(context, {
            table: side.expr.table == null ? null : String(side.expr.table),
            column: String(side.expr.column ?? ''),
          });
          if (!resolved || typeof resolved === 'string') continue;
          if (!isString(resolved.column)) continue;
          if (literalKind(side.other) !== 'number') continue;
          hits.push({
            message: `\`${resolved.table.name}\`.\`${resolved.column.name}\` is ${resolved.column.dataType}, but the predicate compares it to a number. MySQL may convert every row before comparing.`,
            recommendation:
              'Pass the value as a string, or change the column type if it stores numbers.',
            line: lineFor(context, resolved.column.name, fallbackLine),
            object: { table: resolved.table.name, column: resolved.column.name },
            confidence: 'medium',
          });
        }
      });
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.implicit-cast-literal',
      title: 'String literal compared to a non-text column',
      severity: 'low',
      category: 'correctness',
    },
    ({ context, ast, fallbackLine }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table: string; column: string };
        confidence: 'medium';
      }> = [];
      walk(ast, (node) => {
        if (node.type !== 'binary_expr') return;
        const operator = String(node.operator ?? '').toUpperCase();
        if (!['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE'].includes(operator)) {
          return;
        }
        for (const side of comparisonSides(node)) {
          if (!isRecord(side.expr) || side.expr.type !== 'column_ref') continue;
          const resolved = resolveRef(context, {
            table: side.expr.table == null ? null : String(side.expr.table),
            column: String(side.expr.column ?? ''),
          });
          if (!resolved || typeof resolved === 'string') continue;
          if (!isNumeric(resolved.column) && !isTemporal(resolved.column)) continue;
          if (literalKind(side.other) !== 'string') continue;
          hits.push({
            message: `The predicate supplies a string for ${resolved.column.dataType} column \`${resolved.column.name}\`. MySQL will coerce it and may hide invalid values.`,
            recommendation: 'Use a typed value or a date/number literal in the correct format.',
            line: lineFor(context, resolved.column.name, fallbackLine),
            object: { table: resolved.table.name, column: resolved.column.name },
            confidence: 'medium',
          });
        }
      });
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.like-numeric-column',
      title: 'LIKE on a numeric column',
      severity: 'medium',
      category: 'performance',
    },
    ({ context, ast, fallbackLine }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table: string; column: string };
      }> = [];
      walk(ast, (node) => {
        if (node.type !== 'binary_expr') return;
        const operator = String(node.operator ?? '').toUpperCase();
        if (!operator.includes('LIKE')) return;
        for (const side of comparisonSides(node)) {
          if (!isRecord(side.expr) || side.expr.type !== 'column_ref') continue;
          const resolved = resolveRef(context, {
            table: side.expr.table == null ? null : String(side.expr.table),
            column: String(side.expr.column ?? ''),
          });
          if (!resolved || typeof resolved === 'string') continue;
          if (!isNumeric(resolved.column)) continue;
          hits.push({
            message:
              'LIKE forces MySQL to convert the numeric column to text, which prevents index use.',
            recommendation:
              'Use numeric comparison operators, or change the column type if it stores text.',
            line: lineFor(context, resolved.column.name, fallbackLine),
            object: { table: resolved.table.name, column: resolved.column.name },
          });
        }
      });
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.leading-wildcard-indexed',
      title: 'Leading wildcard defeats the index',
      severity: 'medium',
      category: 'performance',
    },
    ({ context, ast, fallbackLine }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table: string; column: string; index: string };
      }> = [];
      walk(ast, (node) => {
        if (node.type !== 'binary_expr') return;
        const operator = String(node.operator ?? '').toUpperCase();
        if (operator !== 'LIKE') return;
        for (const side of comparisonSides(node)) {
          if (!isRecord(side.expr) || side.expr.type !== 'column_ref') continue;
          const resolved = resolveRef(context, {
            table: side.expr.table == null ? null : String(side.expr.table),
            column: String(side.expr.column ?? ''),
          });
          if (!resolved || typeof resolved === 'string') continue;
          const pattern = literalValue(side.other);
          if (typeof pattern !== 'string') continue;
          if (!pattern.startsWith('%') && !pattern.startsWith('_')) continue;
          const index = leadingIndex(resolved.table, resolved.column.name);
          if (!index) continue;
          hits.push({
            message: `The index \`${index.name}\` on \`${resolved.table.name}\` cannot serve this leading-wildcard LIKE.`,
            recommendation: 'Use a prefix pattern or a FULLTEXT index for contains-style search.',
            line: lineFor(context, resolved.column.name, fallbackLine),
            object: {
              table: resolved.table.name,
              column: resolved.column.name,
              index: index.name,
            },
          });
        }
      });
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.not-in-nullable',
      title: 'NOT IN over a nullable column',
      severity: 'medium',
      category: 'correctness',
    },
    ({ context, ast, fallbackLine }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table: string; column: string };
      }> = [];
      walk(ast, (node) => {
        if (node.type !== 'binary_expr') return;
        const operator = String(node.operator ?? '').toUpperCase();
        if (operator !== 'NOT IN' && operator !== 'NOT_IN') return;
        if (!isRecord(node.left) || node.left.type !== 'column_ref') return;
        const resolved = resolveRef(context, {
          table: node.left.table == null ? null : String(node.left.table),
          column: String(node.left.column ?? ''),
        });
        if (!resolved || typeof resolved === 'string') return;
        if (!resolved.column.nullable) return;
        hits.push({
          message: `\`${resolved.column.name}\` is nullable; if any compared value is NULL, NOT IN returns no rows.`,
          recommendation: 'Use NOT EXISTS, or add IS NOT NULL and verify the data.',
          line: lineFor(context, resolved.column.name, fallbackLine),
          object: { table: resolved.table.name, column: resolved.column.name },
        });
      });
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.function-on-indexed-column',
      title: 'Function wrapped around an indexed column',
      severity: 'medium',
      category: 'performance',
    },
    ({ context, ast, fallbackLine }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table: string; column: string; index: string };
      }> = [];
      walk(ast, (node) => {
        if (node.type !== 'function') return;
        const name = functionName(node).toUpperCase();
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
          hits.push({
            message: `${name}() wraps \`${resolved.column.name}\`, so MySQL cannot use index \`${index.name}\` directly.`,
            recommendation:
              'Rewrite as a range predicate, or add a functional/generated-column index.',
            line: lineFor(context, resolved.column.name, fallbackLine),
            object: {
              table: resolved.table.name,
              column: resolved.column.name,
              index: index.name,
            },
          });
        }
      });
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.no-primary-key-target',
      title: 'Writing to a table without a primary key',
      severity: 'high',
      category: 'schema',
    },
    ({ context, ast, fallbackLine }) => {
      if (ast.type !== 'update' && ast.type !== 'delete') return null;
      const tables = Array.isArray(ast.table) ? ast.table : [];
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { database: string; table: string };
      }> = [];
      for (const entry of tables) {
        if (!isRecord(entry)) continue;
        const table = tableForEntry(context, entry);
        if (!table) continue;
        const hasPrimary = table.indexes.some((index) => index.name.toUpperCase() === 'PRIMARY');
        if (hasPrimary) continue;
        hits.push({
          message: `\`${table.name}\` has no PRIMARY KEY. Row-by-row updates/deletes are harder to make safe and replicate efficiently.`,
          recommendation:
            'Add a primary key, and include it in the WHERE clause for targeted changes.',
          line: fallbackLine,
          object: { database: table.database, table: table.name },
        });
      }
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.join-type-mismatch',
      title: 'Join columns have different types',
      severity: 'high',
      category: 'performance',
    },
    ({ context, ast, fallbackLine }) => {
      if (ast.type !== 'select' || !Array.isArray(ast.from)) return null;
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table: string; column: string };
      }> = [];
      for (const entry of ast.from) {
        if (!isRecord(entry) || !entry.join || !isRecord(entry.on)) continue;
        for (const condition of joinConditions(entry)) {
          if (condition.left.type !== 'column_ref' || condition.right.type !== 'column_ref') {
            continue;
          }
          const leftResolved = resolveRef(context, {
            table: condition.left.table == null ? null : String(condition.left.table),
            column: String(condition.left.column ?? ''),
          });
          const rightResolved = resolveRef(context, {
            table: condition.right.table == null ? null : String(condition.right.table),
            column: String(condition.right.column ?? ''),
          });
          if (
            !leftResolved ||
            !rightResolved ||
            typeof leftResolved === 'string' ||
            typeof rightResolved === 'string'
          ) {
            continue;
          }
          const mismatched =
            (isNumeric(leftResolved.column) && isString(rightResolved.column)) ||
            (isString(leftResolved.column) && isNumeric(rightResolved.column));
          if (!mismatched) continue;
          hits.push({
            message: `Joining ${leftResolved.table.name}.${leftResolved.column.name} (${leftResolved.column.dataType}) to ${rightResolved.table.name}.${rightResolved.column.name} (${rightResolved.column.dataType}) forces a conversion on one side.`,
            recommendation:
              'Use matching data types for join keys, or add a generated/cast column if the schema cannot change.',
            line: fallbackLine,
            object: {
              table: leftResolved.table.name,
              column: leftResolved.column.name,
            },
          });
        }
      }
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<QuerySchemaRuleInput>(
    {
      id: 'sql.join-without-index',
      title: 'Join column is not indexed',
      severity: 'medium',
      category: 'performance',
    },
    ({ context, ast, fallbackLine }) => {
      if (ast.type !== 'select' || !Array.isArray(ast.from)) return null;
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        object: { table: string; column: string };
      }> = [];
      for (const entry of ast.from) {
        if (!isRecord(entry) || !entry.join || !isRecord(entry.on)) continue;
        const joinedTable = tableForEntry(context, entry);
        if (!joinedTable) continue;
        for (const condition of joinConditions(entry)) {
          if (condition.left.type !== 'column_ref' || condition.right.type !== 'column_ref') {
            continue;
          }
          const leftResolved = resolveRef(context, {
            table: condition.left.table == null ? null : String(condition.left.table),
            column: String(condition.left.column ?? ''),
          });
          const rightResolved = resolveRef(context, {
            table: condition.right.table == null ? null : String(condition.right.table),
            column: String(condition.right.column ?? ''),
          });
          if (
            !leftResolved ||
            !rightResolved ||
            typeof leftResolved === 'string' ||
            typeof rightResolved === 'string'
          ) {
            continue;
          }
          const joinedSide =
            leftResolved.table.name === joinedTable.name && leftResolved.column.name
              ? leftResolved
              : rightResolved.table.name === joinedTable.name
                ? rightResolved
                : null;
          if (!joinedSide) continue;
          const index = leadingIndex(joinedSide.table, joinedSide.column.name);
          if (index) continue;
          hits.push({
            message: `\`${joinedSide.table.name}\`.\`${joinedSide.column.name}\` is used as a join key but is not the leading column of an index.`,
            recommendation:
              'Add an index on the join column, or extend an existing index so it starts with that column.',
            line: fallbackLine,
            object: {
              table: joinedSide.table.name,
              column: joinedSide.column.name,
            },
          });
        }
      }
      return hits.length > 0 ? hits : null;
    },
  ),
];

interface JoinCondition {
  left: AnyRecord;
  right: AnyRecord;
}

/** Collects the `=` conditions of a join's ON clause. */
function joinConditions(entry: AnyRecord): JoinCondition[] {
  const conditions: JoinCondition[] = [];
  const collectEquals = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.type === 'binary_expr' && String(node.operator).toUpperCase() === '=') {
      const left = node.left;
      const right = node.right;
      if (isRecord(left) && isRecord(right)) {
        conditions.push({ left, right });
      }
    }
    if (node.type === 'binary_expr') {
      collectEquals(node.left);
      collectEquals(node.right);
    }
  };
  collectEquals(entry.on);
  return conditions;
}

export function runQuerySchemaRules(context: RuleContext) {
  if (!context.schema) return [];
  const findings = [];
  // A column is reported at most once per rule, even when it appears in
  // several comparisons in the same script.
  const seen = new Set<string>();

  for (let statementIndex = 0; statementIndex < context.asts.length; statementIndex += 1) {
    const ast = context.asts[statementIndex];
    if (!isRecord(ast)) continue;
    const statement = context.statements[statementIndex];
    const produced = runRules(QUERY_SCHEMA_RULES, {
      context,
      ast,
      fallbackLine: statement?.line ?? 1,
    });
    for (const finding of produced) {
      const key = `${finding.ruleId}|${finding.object?.table ?? ''}|${finding.object?.column ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(finding);
    }
  }

  return findings;
}
