import type { Token } from '../tokenizer';
import { tokenUpper } from '../tokenizer';
import type { StatementInfo } from '../sql-classifier';
import {
  astType,
  collectColumnRefs,
  fromEntries,
  functionName,
  hasAggregate,
  hasSubquery,
  isRecord,
  isStarColumn,
  numberValue,
  primaryTable,
  selectedColumns,
  stringValue,
  walk,
  type AnyRecord,
} from '../ast-utils';
import { defineRule, runRules, type Rule } from './descriptor';
import type { RuleContext } from './types';

/**
 * Finds a sequence of words anywhere in the token stream.
 *
 * This deliberately ignores parenthesis depth, matching the behaviour the
 * rules have always had. Use `tokenizer.findTopLevelSequence` when a
 * top-level-only match is required.
 */
function findSequence(tokens: Token[], words: string[]): number {
  const upper = words.map((word) => word.toUpperCase());
  for (let i = 0; i <= tokens.length - upper.length; i += 1) {
    let match = true;
    for (let j = 0; j < upper.length; j += 1) {
      const token = tokens[i + j];
      if (token.kind !== 'word' || tokenUpper(token) !== upper[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** Reads the LIMIT clause of a statement, tolerating the parser's `seperator` spelling. */
function limitInfo(ast: unknown): { count: number; offset: number } | null {
  if (!isRecord(ast) || !isRecord(ast.limit)) return null;
  const value = Array.isArray(ast.limit.value) ? ast.limit.value : [];
  const first = numberValue(value[0]);
  const second = numberValue(value[1]);
  if (first == null && second == null) return null;
  const separator = String(ast.limit.seperator ?? ast.limit.separator ?? '');
  if (separator === ',') {
    return { offset: first ?? 0, count: second ?? 0 };
  }
  return { count: first ?? 0, offset: second ?? 0 };
}

function hasJoin(ast: unknown): boolean {
  const entries = fromEntries(ast);
  if (entries.length > 1) return true;
  return entries.some((entry) => entry.join != null || entry.on != null);
}

/** A column reference, reduced to the parts that identify it. */
interface ColumnKey {
  /** The table the column belongs to, or `null` when it is unqualified. */
  table: string | null;
  column: string;
}

/**
 * Reduces a column reference to a comparable key.
 *
 * An alias is resolved to the table it stands for, so `u.name` and `name`
 * (with `u` the only source of `name`) describe the same column.
 */
function columnKey(context: RuleContext, table: string | null, column: string): ColumnKey {
  const lower = column.toLowerCase();
  if (!table) return { table: null, column: lower };
  const qualifier = table.toLowerCase();
  const resolved = context.aliases.get(qualifier);
  return { table: (resolved ?? qualifier).toLowerCase(), column: lower };
}

/**
 * True when two column references describe the same column.
 *
 * An unqualified reference matches a qualified one: MySQL resolves the bare
 * column against the tables in scope, so `GROUP BY name` covers `u.name`.
 * Two references that name different tables never match.
 */
function sameColumn(left: ColumnKey, right: ColumnKey): boolean {
  if (left.column !== right.column) return false;
  if (!left.table || !right.table) return true;
  return left.table === right.table;
}

export interface SqlStatementRuleInput {
  context: RuleContext;
  index: number;
  statement: StatementInfo;
  ast: AnyRecord | null;
  tokens: Token[];
  line: number;
  /** The AST `type` of the statement, e.g. `select`, `update`, `insert`. */
  type: string;
  /** The first keyword of the statement, upper-cased. */
  firstWord: string;
  /** The first table named in the FROM clause, when the statement has one. */
  objectTable: string | null;
}

export const SQL_STATEMENT_RULES: Rule<SqlStatementRuleInput>[] = [
  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.update-without-where',
      title: 'UPDATE without WHERE',
      severity: 'critical',
      category: 'correctness',
    },
    ({ ast, type, line, objectTable }) =>
      type === 'update' && ast !== null && ast.where == null
        ? {
            message: 'This UPDATE has no WHERE clause and will modify every row in the table.',
            recommendation:
              'Add a WHERE clause. Test it with a SELECT first, and keep a transaction or backup ready.',
            line,
            object: objectTable ? { table: objectTable } : undefined,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.delete-without-where',
      title: 'DELETE without WHERE',
      severity: 'critical',
      category: 'correctness',
    },
    ({ ast, type, line, objectTable }) =>
      type === 'delete' && ast !== null && ast.where == null
        ? {
            message: 'This DELETE has no WHERE clause and will remove every row in the table.',
            recommendation:
              'Add a WHERE clause. Preview the affected rows with SELECT before deleting.',
            line,
            object: objectTable ? { table: objectTable } : undefined,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.drop-statement',
      title: 'Destructive DROP statement',
      severity: 'high',
      category: 'correctness',
    },
    ({ firstWord, line, objectTable }) =>
      firstWord === 'DROP'
        ? {
            message: 'DROP permanently removes the object and its data.',
            recommendation:
              'Verify the target, take a backup, and confirm that no application still depends on it.',
            line,
            object: objectTable ? { table: objectTable } : undefined,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.truncate-statement',
      title: 'TRUNCATE removes all rows',
      severity: 'high',
      category: 'correctness',
    },
    ({ firstWord, line, objectTable }) =>
      firstWord === 'TRUNCATE'
        ? {
            message:
              'TRUNCATE removes every row and resets auto-increment state. It cannot be rolled back in MySQL.',
            recommendation:
              'Use DELETE inside a transaction if you need rollback, or confirm with a backup first.',
            line,
            object: objectTable ? { table: objectTable } : undefined,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.alter-table',
      title: 'Schema-changing ALTER',
      severity: 'medium',
      category: 'maintainability',
    },
    ({ firstWord, line, objectTable }) =>
      firstWord === 'ALTER'
        ? {
            message:
              'ALTER TABLE can lock or rebuild the table depending on the operation and server version.',
            recommendation:
              'Test on a copy, check the algorithm/lock mode, and run it during a maintenance window.',
            line,
            object: objectTable ? { table: objectTable } : undefined,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.use-statement',
      title: 'USE statement in a pooled session',
      severity: 'medium',
      category: 'correctness',
    },
    ({ firstWord, line }) =>
      firstWord === 'USE'
        ? {
            message:
              'Connection pools do not reliably preserve session state, so USE can surprise later queries.',
            recommendation: 'Use the database selector in the app, or fully qualify table names.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.null-equality',
      title: 'Comparison with NULL using an equality operator',
      severity: 'high',
      category: 'correctness',
    },
    ({ tokens }) => {
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
        column: number;
      }> = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (!(token.kind === 'punct' && ['=', '!=', '<>'].includes(token.value))) continue;
        const prev = tokens[i - 1];
        const next = tokens[i + 1];
        const prevNull = prev && prev.kind === 'word' && tokenUpper(prev) === 'NULL';
        const nextNull = next && next.kind === 'word' && tokenUpper(next) === 'NULL';
        if (!prevNull && !nextNull) continue;
        hits.push({
          message: `${token.value} NULL never evaluates to TRUE in MySQL; it returns NULL.`,
          recommendation: 'Use IS NULL or IS NOT NULL instead.',
          line: token.line,
          column: token.column,
        });
        break;
      }
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.not-in',
      title: 'NOT IN can silently return no rows',
      severity: 'low',
      category: 'correctness',
    },
    ({ tokens }) => {
      const notInIndex = findSequence(tokens, ['NOT', 'IN']);
      if (notInIndex < 0) return null;
      const token = tokens[notInIndex];
      const following = tokens.slice(notInIndex + 2, notInIndex + 200);
      const hasSelect = following.some(
        (item, i) => item.kind === 'word' && tokenUpper(item) === 'SELECT' && i > 0,
      );
      return {
        message: hasSelect
          ? 'NOT IN with a subquery is unsafe when the subquery can produce NULL.'
          : 'NOT IN with a NULLable column can evaluate to UNKNOWN and filter out every row.',
        recommendation:
          'Prefer NOT EXISTS, or make the column/subquery non-null and verify the data.',
        line: token.line,
        column: token.column,
        severity: hasSelect ? ('medium' as const) : ('low' as const),
        confidence: 'medium' as const,
      };
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.cartesian-join',
      title: 'Cartesian product / implicit cross join',
      severity: 'high',
      category: 'correctness',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      const entries = fromEntries(ast);
      const commaJoin = entries.length > 1 && entries.slice(1).some((entry) => !entry.join);
      const crossJoin = entries.some((entry) =>
        String(entry.join ?? '')
          .toUpperCase()
          .includes('CROSS'),
      );
      if (!commaJoin && !crossJoin) return null;
      return {
        message:
          'The FROM clause contains multiple tables without an explicit join condition, which multiplies rows.',
        recommendation: 'Use an explicit JOIN ... ON clause for every related table.',
        line,
      };
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.or-condition',
      title: 'OR predicate can prevent index use',
      severity: 'medium',
      category: 'performance',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      let hasOr = false;
      walk(ast.where, (current) => {
        if (current.type === 'binary_expr' && String(current.operator).toUpperCase() === 'OR') {
          hasOr = true;
        }
      });
      if (!hasOr) return null;
      return {
        message: 'The WHERE clause uses OR, which often forces a scan or index merge.',
        recommendation:
          'Consider UNION ALL of two indexed branches, or verify the plan with EXPLAIN.',
        line,
        confidence: 'medium' as const,
      };
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.group-by-nonaggregated',
      title: 'Selected column is not in GROUP BY',
      severity: 'medium',
      category: 'correctness',
    },
    ({ ast, line, context }) => {
      if (!ast || ast.type !== 'select') return null;
      const groupColumns: ColumnKey[] = [];
      if (isRecord(ast.groupby) && Array.isArray(ast.groupby.columns)) {
        for (const groupColumn of ast.groupby.columns) {
          for (const ref of collectColumnRefs(groupColumn)) {
            groupColumns.push(columnKey(context, ref.table, ref.column));
          }
        }
      }
      if (groupColumns.length === 0) return null;
      for (const column of selectedColumns(ast)) {
        if (hasAggregate(column)) continue;
        const refs = collectColumnRefs(column);
        if (
          refs.some(
            (ref) =>
              !groupColumns.some((group) =>
                sameColumn(group, columnKey(context, ref.table, ref.column)),
              ),
          )
        ) {
          return {
            message:
              'A non-aggregated selected column is not part of GROUP BY, so MySQL may return an arbitrary value.',
            recommendation:
              'Add the column to GROUP BY, wrap it in an aggregate, or use ANY_VALUE() if arbitrary selection is intended.',
            line,
            confidence: 'medium' as const,
          };
        }
      }
      return null;
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.having-without-group',
      title: 'HAVING without GROUP BY',
      severity: 'low',
      category: 'correctness',
    },
    ({ ast, line }) =>
      ast !== null && ast.type === 'select' && ast.having != null && ast.groupby == null
        ? {
            message:
              'HAVING without GROUP BY is legal but often indicates a WHERE predicate in the wrong place.',
            recommendation: 'Move row-level filters to WHERE; keep HAVING for aggregate filters.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.order-by-rand',
      title: 'ORDER BY RAND() sorts the whole result',
      severity: 'medium',
      category: 'performance',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      const orderBy = Array.isArray(ast.orderby) ? ast.orderby : [];
      for (const order of orderBy) {
        let found = false;
        walk(order, (current) => {
          if (current.type === 'function' && functionName(current).toUpperCase() === 'RAND') {
            found = true;
          }
        });
        if (found) {
          return {
            message:
              'ORDER BY RAND() generates a random value for every row before sorting, which becomes expensive at scale.',
            recommendation: 'Pick random keys first, or use an application-side sample instead.',
            line,
          };
        }
      }
      return null;
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.large-offset',
      title: 'Large OFFSET pagination',
      severity: 'low',
      category: 'performance',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      const limit = limitInfo(ast);
      if (!limit || limit.offset <= 1000) return null;
      return {
        message: `OFFSET ${limit.offset} makes the server read and discard that many rows.`,
        recommendation: 'Use keyset pagination (WHERE id > last_seen_id) for deep pages.',
        line,
      };
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.huge-limit',
      title: 'Very large LIMIT',
      severity: 'info',
      category: 'performance',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      const limit = limitInfo(ast);
      if (!limit || limit.count <= 1_000_000) return null;
      return {
        message: `LIMIT ${limit.count} may return far more data than the UI or caller can handle.`,
        recommendation: 'Use a smaller page size and paginate.',
        line,
      };
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.select-star',
      title: 'SELECT * returns every column',
      severity: 'low',
      category: 'performance',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      const stars = selectedColumns(ast).filter(isStarColumn);
      if (stars.length === 0) return null;
      const joined = hasJoin(ast);
      return {
        message: joined
          ? 'SELECT * across joins can duplicate column names and transfer unnecessary data.'
          : 'SELECT * transfers columns the caller may not need and breaks when the schema changes.',
        recommendation: 'List the columns you actually use.',
        line,
        severity: joined ? ('medium' as const) : ('low' as const),
      };
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.select-without-limit',
      title: 'SELECT without LIMIT',
      severity: 'info',
      category: 'performance',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      if (ast.limit != null) return null;
      if (hasAggregate(ast.columns)) return null;
      return {
        message: 'The query has no LIMIT, so it can return an unbounded result set.',
        recommendation:
          'Add a LIMIT for interactive queries, or confirm that the full result is intended.',
        line,
        confidence: 'low' as const,
      };
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.order-by-without-limit',
      title: 'ORDER BY without LIMIT',
      severity: 'info',
      category: 'performance',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      if (ast.limit != null) return null;
      // Only reported when the statement aggregates; otherwise the unbounded
      // SELECT is reported by `sql.select-without-limit` instead.
      if (!hasAggregate(ast.columns)) return null;
      if (ast.orderby == null) return null;
      return {
        message: 'ORDER BY without LIMIT still sorts the whole result set.',
        recommendation: 'Add LIMIT when you only need the top rows.',
        line,
      };
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.distinct',
      title: 'DISTINCT can hide duplicate joins',
      severity: 'low',
      category: 'performance',
    },
    ({ ast, line }) =>
      ast !== null && ast.type === 'select' && ast.distinct != null
        ? {
            message:
              'DISTINCT often masks a join that produces duplicate rows, and it forces a deduplication step.',
            recommendation: 'Verify the join cardinality; remove DISTINCT if the join is correct.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.subquery-in-where',
      title: 'Subquery in the WHERE clause',
      severity: 'medium',
      category: 'performance',
    },
    ({ ast, line }) =>
      ast !== null && ast.type === 'select' && hasSubquery(ast.where)
        ? {
            message:
              'A subquery in WHERE can be materialized or executed repeatedly, depending on the version and plan.',
            recommendation: 'Compare the EXPLAIN plan with an equivalent JOIN or EXISTS rewrite.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.leading-wildcard',
      title: 'LIKE with a leading wildcard',
      severity: 'medium',
      category: 'performance',
    },
    ({ ast, line }) => {
      if (!ast || ast.type !== 'select') return null;
      const hits: Array<{
        message: string;
        recommendation: string;
        line: number;
      }> = [];
      const collect = (node: unknown): void => {
        walk(node, (current) => {
          if (
            current.type === 'binary_expr' &&
            ['LIKE', 'NOT LIKE'].includes(String(current.operator).toUpperCase())
          ) {
            const value = stringValue(current.right);
            if (value && (value.startsWith('%') || value.startsWith('_'))) {
              hits.push({
                message:
                  'The pattern starts with a wildcard, so MySQL cannot use a normal B-tree index for the search.',
                recommendation:
                  "Use a prefix search (LIKE 'term%') or a dedicated full-text index.",
                line,
              });
            }
          }
        });
      };
      // The select list is checked first, matching the order findings were
      // reported in before the rule was unified.
      for (const column of selectedColumns(ast)) collect(column.expr);
      collect(ast.where);
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.insert-without-columns',
      title: 'INSERT without a column list',
      severity: 'medium',
      category: 'maintainability',
    },
    ({ ast, type, line, objectTable }) =>
      // `INSERT ... SET name = 'x'` names its columns in `set`; only a
      // statement with neither a column list nor a SET clause is unnamed.
      (type === 'insert' || type === 'replace') &&
      ast !== null &&
      ast.columns == null &&
      ast.set == null
        ? {
            message:
              'Without a column list, the statement breaks if the table gains, loses, or reorders columns.',
            recommendation: 'List the target columns explicitly.',
            line,
            object: objectTable ? { table: objectTable } : undefined,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.replace-into',
      title: 'REPLACE deletes and reinserts rows',
      severity: 'medium',
      category: 'correctness',
    },
    ({ firstWord, line }) =>
      firstWord === 'REPLACE'
        ? {
            message:
              'REPLACE removes conflicting rows before inserting, which can break foreign keys and triggers.',
            recommendation:
              'Use INSERT ... ON DUPLICATE KEY UPDATE when a true upsert is intended.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.select-for-update',
      title: 'SELECT ... FOR UPDATE takes exclusive row locks',
      severity: 'high',
      category: 'correctness',
    },
    ({ tokens, line }) =>
      findSequence(tokens, ['FOR', 'UPDATE']) >= 0
        ? {
            message:
              'Rows touched by this query are locked until the transaction ends, which can block other sessions.',
            recommendation:
              'Keep the transaction short and ensure the predicate uses an index to avoid gap locks.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.lock-in-share-mode',
      title: 'Shared lock read',
      severity: 'medium',
      category: 'correctness',
    },
    ({ tokens, line }) =>
      findSequence(tokens, ['LOCK', 'IN', 'SHARE', 'MODE']) >= 0 ||
      findSequence(tokens, ['FOR', 'SHARE']) >= 0
        ? {
            message: 'The query takes shared locks that can still block writers.',
            recommendation:
              'Confirm the lock is required; prefer a plain consistent read when possible.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.sql-calc-found-rows',
      title: 'SQL_CALC_FOUND_ROWS is deprecated and slow',
      severity: 'medium',
      category: 'performance',
    },
    ({ tokens, line }) =>
      findSequence(tokens, ['SQL_CALC_FOUND_ROWS']) >= 0
        ? {
            message: 'SQL_CALC_FOUND_ROWS often prevents efficient LIMIT handling.',
            recommendation:
              'Run a separate COUNT(*) query, or use a window function on MySQL 8+/MariaDB 10.2+.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.regexp-predicate',
      title: 'Regular-expression predicate',
      severity: 'low',
      category: 'performance',
    },
    ({ tokens, line }) =>
      // Only a word token can be the operator; a string literal such as
      // `WHERE name = 'regexp'` must not trigger the rule.
      tokens.some(
        (token) => token.kind === 'word' && ['REGEXP', 'RLIKE'].includes(tokenUpper(token)),
      )
        ? {
            message:
              'REGEXP/RLIKE usually cannot use an index and evaluates the pattern for every candidate row.',
            recommendation: 'Use anchored LIKE prefixes or a full-text/search index when possible.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.into-outfile',
      title: 'SELECT writes a file on the server',
      severity: 'high',
      category: 'security',
    },
    ({ tokens, line }) =>
      findSequence(tokens, ['INTO', 'OUTFILE']) >= 0 ||
      findSequence(tokens, ['INTO', 'DUMPFILE']) >= 0
        ? {
            message:
              'INTO OUTFILE/DUMPFILE writes data to the MySQL server filesystem and requires FILE privilege.',
            recommendation: 'Use a client-side export instead, and keep FILE privilege restricted.',
            line,
          }
        : null,
  ),

  defineRule<SqlStatementRuleInput>(
    {
      id: 'sql.union-without-all',
      title: 'UNION deduplicates the result',
      severity: 'info',
      category: 'performance',
    },
    ({ tokens, line }) => {
      // Every UNION is inspected: one `UNION ALL` elsewhere in the script
      // does not make a plain `UNION` acceptable.
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.kind !== 'word' || tokenUpper(token) !== 'UNION') continue;
        const next = tokens[i + 1];
        if (next && next.kind === 'word' && tokenUpper(next) === 'ALL') continue;
        return {
          message:
            'UNION removes duplicates and adds a sort/hash step. UNION ALL is cheaper when duplicates are acceptable.',
          recommendation:
            'Use UNION ALL if the branches cannot produce duplicates or duplicates are fine.',
          line,
        };
      }
      return null;
    },
  ),
];

export interface SqlScriptRuleInput {
  context: RuleContext;
}

/** Rules that look at the whole script rather than a single statement. */
export const SQL_SCRIPT_HEAD_RULES: Rule<SqlScriptRuleInput>[] = [
  defineRule<SqlScriptRuleInput>(
    {
      id: 'sql.multi-statement',
      title: 'Multiple statements in one script',
      severity: 'critical',
      category: 'correctness',
    },
    ({ context }) =>
      context.statements.length > 1
        ? {
            message: `${context.statements.length} statements were found. Multi-statement execution is disabled to prevent accidental changes.`,
            recommendation:
              'Run or review one statement at a time. Select a statement and execute it separately.',
            line: context.statements[0].line,
          }
        : null,
  ),
];

/** Script-level rules that need every statement to be evaluated first. */
export const SQL_SCRIPT_TAIL_RULES: Rule<SqlScriptRuleInput>[] = [
  defineRule<SqlScriptRuleInput>(
    {
      id: 'sql.ddl-in-transaction',
      title: 'DDL inside a transaction script',
      severity: 'high',
      category: 'correctness',
    },
    ({ context }) => {
      const hasTransaction =
        context.tokens.some(
          (token) =>
            token.kind === 'word' && ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(tokenUpper(token)),
        ) || findSequence(context.tokens, ['START', 'TRANSACTION']) >= 0;
      if (!hasTransaction) return null;
      const ddlStatement = context.statements.find(
        (statement) => statement.classification.kind === 'ddl',
      );
      if (!ddlStatement) return null;
      return {
        message:
          'MySQL performs an implicit commit before and after DDL, so it cannot be rolled back with the rest of the script.',
        recommendation:
          'Keep DDL out of transactional batches and run it as its own confirmed step.',
        line: ddlStatement.line,
      };
    },
  ),
];

export function runSqlRules(context: RuleContext) {
  const findings = [];

  // Script-level rules that look at the statement count come first.
  findings.push(...runRules(SQL_SCRIPT_HEAD_RULES, { context }));

  context.statements.forEach((statement, index) => {
    const rawAst = context.asts[index];
    const ast = isRecord(rawAst) ? rawAst : null;
    const tokens = statement.tokens;
    const type = astType(ast);
    // The table of a statement lives in `from` (SELECT/DELETE), `table`
    // (UPDATE/INSERT/ALTER) or `name` (DROP/TRUNCATE).
    const objectTable = primaryTable(ast);

    const produced = runRules(SQL_STATEMENT_RULES, {
      context,
      index,
      statement,
      ast,
      tokens,
      line: statement.line,
      type,
      firstWord: tokenUpper(tokens[0]),
      objectTable,
    });
    for (const finding of produced) {
      // The statement index is part of the de-duplication key, so two
      // statements on the same line do not collapse into one finding.
      finding.statementIndex = index;
    }
    findings.push(...produced);
  });

  // Script-level rules that need the whole script come last.
  findings.push(...runRules(SQL_SCRIPT_TAIL_RULES, { context }));

  return findings;
}
