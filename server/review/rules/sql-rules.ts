import type { Finding } from '../../../shared/types';
import { createFinding } from '../findings';
import type { Token } from '../tokenizer';
import { tokenUpper } from '../tokenizer';
import type { RuleContext } from './types';

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function astType(ast: unknown): string {
  return isRecord(ast) && typeof ast.type === 'string' ? ast.type : '';
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

function collectColumnRefs(node: unknown): { table: string | null; column: string }[] {
  const refs: { table: string | null; column: string }[] = [];
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

function hasAggregate(node: unknown): boolean {
  let found = false;
  walk(node, (current) => {
    if (current.type === 'aggr_func') found = true;
  });
  return found;
}

function stringValue(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const type = String(node.type ?? '');
  if (
    type === 'string' ||
    type === 'single_quote_string' ||
    type === 'double_quote_string'
  ) {
    return String(node.value ?? '');
  }
  return null;
}

function numberValue(node: unknown): number | null {
  if (!isRecord(node)) return null;
  if (node.type === 'number') {
    const parsed = Number(node.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

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

function fromEntries(ast: unknown): AnyRecord[] {
  if (!isRecord(ast) || !Array.isArray(ast.from)) return [];
  return ast.from.filter(isRecord);
}

function hasJoin(ast: unknown): boolean {
  const entries = fromEntries(ast);
  if (entries.length > 1) return true;
  return entries.some((entry) => entry.join != null || entry.on != null);
}

function selectedColumns(ast: unknown): AnyRecord[] {
  if (!isRecord(ast) || !Array.isArray(ast.columns)) return [];
  return ast.columns.filter(isRecord);
}

function isStarColumn(column: AnyRecord): boolean {
  const expr = column.expr;
  if (!isRecord(expr)) return false;
  if (expr.type === 'star') return true;
  return expr.type === 'column_ref' && String(expr.column ?? '') === '*';
}

function hasSubquery(node: unknown): boolean {
  let found = false;
  walk(node, (current) => {
    if (current.type === 'select' && current !== node) found = true;
  });
  return found;
}

export function runSqlRules(context: RuleContext): Finding[] {
  const findings: Finding[] = [];

  if (context.statements.length > 1) {
    findings.push(
      createFinding({
        ruleId: 'sql.multi-statement',
        title: 'Multiple statements in one script',
        severity: 'critical',
        category: 'correctness',
        message: `${context.statements.length} statements were found. Multi-statement execution is disabled to prevent accidental changes.`,
        recommendation: 'Run or review one statement at a time. Select a statement and execute it separately.',
        line: context.statements[0].line,
        confidence: 'high',
      }),
    );
  }

  context.statements.forEach((statement, index) => {
    const ast = context.asts[index];
    const tokens = statement.tokens;
    const line = statement.line;
    const type = astType(ast);
    const firstWord = tokenUpper(tokens[0]);
    const objectTable = fromEntries(ast)
      .map((entry) => (entry.table == null ? null : String(entry.table)))
      .find(Boolean);

    if (type === 'update' && isRecord(ast) && ast.where == null) {
      findings.push(
        createFinding({
          ruleId: 'sql.update-without-where',
          title: 'UPDATE without WHERE',
          severity: 'critical',
          category: 'correctness',
          message: 'This UPDATE has no WHERE clause and will modify every row in the table.',
          recommendation: 'Add a WHERE clause. Test it with a SELECT first, and keep a transaction or backup ready.',
          line,
          object: objectTable ? { table: objectTable } : undefined,
          confidence: 'high',
        }),
      );
    }

    if (type === 'delete' && isRecord(ast) && ast.where == null) {
      findings.push(
        createFinding({
          ruleId: 'sql.delete-without-where',
          title: 'DELETE without WHERE',
          severity: 'critical',
          category: 'correctness',
          message: 'This DELETE has no WHERE clause and will remove every row in the table.',
          recommendation: 'Add a WHERE clause. Preview the affected rows with SELECT before deleting.',
          line,
          object: objectTable ? { table: objectTable } : undefined,
          confidence: 'high',
        }),
      );
    }

    if (firstWord === 'DROP') {
      findings.push(
        createFinding({
          ruleId: 'sql.drop-statement',
          title: 'Destructive DROP statement',
          severity: 'high',
          category: 'correctness',
          message: 'DROP permanently removes the object and its data.',
          recommendation: 'Verify the target, take a backup, and confirm that no application still depends on it.',
          line,
          object: objectTable ? { table: objectTable } : undefined,
        }),
      );
    }

    if (firstWord === 'TRUNCATE') {
      findings.push(
        createFinding({
          ruleId: 'sql.truncate-statement',
          title: 'TRUNCATE removes all rows',
          severity: 'high',
          category: 'correctness',
          message: 'TRUNCATE removes every row and resets auto-increment state. It cannot be rolled back in MySQL.',
          recommendation: 'Use DELETE inside a transaction if you need rollback, or confirm with a backup first.',
          line,
          object: objectTable ? { table: objectTable } : undefined,
        }),
      );
    }

    if (firstWord === 'ALTER') {
      findings.push(
        createFinding({
          ruleId: 'sql.alter-table',
          title: 'Schema-changing ALTER',
          severity: 'medium',
          category: 'maintainability',
          message: 'ALTER TABLE can lock or rebuild the table depending on the operation and server version.',
          recommendation: 'Test on a copy, check the algorithm/lock mode, and run it during a maintenance window.',
          line,
          object: objectTable ? { table: objectTable } : undefined,
          confidence: 'high',
        }),
      );
    }

    if (firstWord === 'USE') {
      findings.push(
        createFinding({
          ruleId: 'sql.use-statement',
          title: 'USE statement in a pooled session',
          severity: 'medium',
          category: 'correctness',
          message: 'Connection pools do not reliably preserve session state, so USE can surprise later queries.',
          recommendation: 'Use the database selector in the app, or fully qualify table names.',
          line,
        }),
      );
    }

    // NULL comparisons using = / != / <>
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!(token.kind === 'punct' && ['=', '!=', '<>'].includes(token.value))) continue;
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const prevNull = prev && prev.kind === 'word' && tokenUpper(prev) === 'NULL';
      const nextNull = next && next.kind === 'word' && tokenUpper(next) === 'NULL';
      if (prevNull || nextNull) {
        findings.push(
          createFinding({
            ruleId: 'sql.null-equality',
            title: 'Comparison with NULL using an equality operator',
            severity: 'high',
            category: 'correctness',
            message: `${token.value} NULL never evaluates to TRUE in MySQL; it returns NULL.`,
            recommendation: 'Use IS NULL or IS NOT NULL instead.',
            line: token.line,
            column: token.column,
            confidence: 'high',
          }),
        );
        break;
      }
    }

    // NOT IN semantics with NULL
    const notInIndex = findSequence(tokens, ['NOT', 'IN']);
    if (notInIndex >= 0) {
      const token = tokens[notInIndex];
      const following = tokens.slice(notInIndex + 2, notInIndex + 200);
      const hasSelect = following.some(
        (item, i) => item.kind === 'word' && tokenUpper(item) === 'SELECT' && i > 0,
      );
      findings.push(
        createFinding({
          ruleId: 'sql.not-in',
          title: 'NOT IN can silently return no rows',
          severity: hasSelect ? 'medium' : 'low',
          category: 'correctness',
          message: hasSelect
            ? 'NOT IN with a subquery is unsafe when the subquery can produce NULL.'
            : 'NOT IN with a NULLable column can evaluate to UNKNOWN and filter out every row.',
          recommendation: 'Prefer NOT EXISTS, or make the column/subquery non-null and verify the data.',
          line: token.line,
          column: token.column,
          confidence: 'medium',
        }),
      );
    }

    if (type === 'select' && isRecord(ast)) {
      const entries = fromEntries(ast);
      const commaJoin = entries.length > 1 && entries.slice(1).some((entry) => !entry.join);
      const crossJoin = entries.some(
        (entry) => String(entry.join ?? '').toUpperCase().includes('CROSS'),
      );
      if (commaJoin || crossJoin) {
        findings.push(
          createFinding({
            ruleId: 'sql.cartesian-join',
            title: 'Cartesian product / implicit cross join',
            severity: 'high',
            category: 'correctness',
            message:
              'The FROM clause contains multiple tables without an explicit join condition, which multiplies rows.',
            recommendation: 'Use an explicit JOIN ... ON clause for every related table.',
            line,
            confidence: 'high',
          }),
        );
      }

      let hasOr = false;
      walk(ast.where, (current) => {
        if (current.type === 'binary_expr' && String(current.operator).toUpperCase() === 'OR') {
          hasOr = true;
        }
      });
      if (hasOr) {
        findings.push(
          createFinding({
            ruleId: 'sql.or-condition',
            title: 'OR predicate can prevent index use',
            severity: 'medium',
            category: 'performance',
            message: 'The WHERE clause uses OR, which often forces a scan or index merge.',
            recommendation: 'Consider UNION ALL of two indexed branches, or verify the plan with EXPLAIN.',
            line,
            confidence: 'medium',
          }),
        );
      }

      const groupColumns = new Set<string>();
      if (isRecord(ast.groupby) && Array.isArray(ast.groupby.columns)) {
        for (const groupColumn of ast.groupby.columns) {
          for (const ref of collectColumnRefs(groupColumn)) {
            groupColumns.add(`${ref.table ?? ''}.${ref.column}`.toLowerCase());
          }
        }
      }
      if (groupColumns.size > 0) {
        let nonAggregated = false;
        for (const column of selectedColumns(ast)) {
          if (hasAggregate(column)) continue;
          const refs = collectColumnRefs(column);
          if (
            refs.some(
              (ref) => !groupColumns.has(`${ref.table ?? ''}.${ref.column}`.toLowerCase()),
            )
          ) {
            nonAggregated = true;
          }
        }
        if (nonAggregated) {
          findings.push(
            createFinding({
              ruleId: 'sql.group-by-nonaggregated',
              title: 'Selected column is not in GROUP BY',
              severity: 'medium',
              category: 'correctness',
              message:
                'A non-aggregated selected column is not part of GROUP BY, so MySQL may return an arbitrary value.',
              recommendation:
                'Add the column to GROUP BY, wrap it in an aggregate, or use ANY_VALUE() if arbitrary selection is intended.',
              line,
              confidence: 'medium',
            }),
          );
        }
      }

      if (ast.having != null && ast.groupby == null) {
        findings.push(
          createFinding({
            ruleId: 'sql.having-without-group',
            title: 'HAVING without GROUP BY',
            severity: 'low',
            category: 'correctness',
            message: 'HAVING without GROUP BY is legal but often indicates a WHERE predicate in the wrong place.',
            recommendation: 'Move row-level filters to WHERE; keep HAVING for aggregate filters.',
            line,
          }),
        );
      }

      const orderBy = Array.isArray(ast.orderby) ? ast.orderby : [];
      let orderByRand = false;
      for (const order of orderBy) {
        walk(order, (current) => {
          if (current.type === 'function') {
            const name = current.name;
            const functionName =
              typeof name === 'string'
                ? name
                : isRecord(name) && Array.isArray(name.name)
                  ? name.name
                      .map((part) => (isRecord(part) ? String(part.value ?? '') : ''))
                      .join('')
                  : '';
            if (functionName.toUpperCase() === 'RAND') orderByRand = true;
          }
        });
      }
      if (orderByRand) {
        findings.push(
          createFinding({
            ruleId: 'sql.order-by-rand',
            title: 'ORDER BY RAND() sorts the whole result',
            severity: 'medium',
            category: 'performance',
            message: 'ORDER BY RAND() generates a random value for every row before sorting, which becomes expensive at scale.',
            recommendation: 'Pick random keys first, or use an application-side sample instead.',
            line,
          }),
        );
      }

      const limit = limitInfo(ast);
      if (limit && limit.offset > 1000) {
        findings.push(
          createFinding({
            ruleId: 'sql.large-offset',
            title: 'Large OFFSET pagination',
            severity: 'low',
            category: 'performance',
            message: `OFFSET ${limit.offset} makes the server read and discard that many rows.`,
            recommendation: 'Use keyset pagination (WHERE id > last_seen_id) for deep pages.',
            line,
          }),
        );
      }
      if (limit && limit.count > 1_000_000) {
        findings.push(
          createFinding({
            ruleId: 'sql.huge-limit',
            title: 'Very large LIMIT',
            severity: 'info',
            category: 'performance',
            message: `LIMIT ${limit.count} may return far more data than the UI or caller can handle.`,
            recommendation: 'Use a smaller page size and paginate.',
            line,
          }),
        );
      }

      const stars = selectedColumns(ast).filter(isStarColumn);
      if (stars.length > 0) {
        findings.push(
          createFinding({
            ruleId: 'sql.select-star',
            title: 'SELECT * returns every column',
            severity: hasJoin(ast) ? 'medium' : 'low',
            category: 'performance',
            message: hasJoin(ast)
              ? 'SELECT * across joins can duplicate column names and transfer unnecessary data.'
              : 'SELECT * transfers columns the caller may not need and breaks when the schema changes.',
            recommendation: 'List the columns you actually use.',
            line,
          }),
        );
      }

      if (ast.limit == null && !hasAggregate(ast.columns)) {
        findings.push(
          createFinding({
            ruleId: 'sql.select-without-limit',
            title: 'SELECT without LIMIT',
            severity: 'info',
            category: 'performance',
            message: 'The query has no LIMIT, so it can return an unbounded result set.',
            recommendation: 'Add a LIMIT for interactive queries, or confirm that the full result is intended.',
            line,
            confidence: 'low',
          }),
        );
      } else if (ast.limit == null && ast.orderby != null) {
        findings.push(
          createFinding({
            ruleId: 'sql.order-by-without-limit',
            title: 'ORDER BY without LIMIT',
            severity: 'info',
            category: 'performance',
            message: 'ORDER BY without LIMIT still sorts the whole result set.',
            recommendation: 'Add LIMIT when you only need the top rows.',
            line,
          }),
        );
      }

      if (ast.distinct != null) {
        findings.push(
          createFinding({
            ruleId: 'sql.distinct',
            title: 'DISTINCT can hide duplicate joins',
            severity: 'low',
            category: 'performance',
            message: 'DISTINCT often masks a join that produces duplicate rows, and it forces a deduplication step.',
            recommendation: 'Verify the join cardinality; remove DISTINCT if the join is correct.',
            line,
          }),
        );
      }

      const whereSubquery = isRecord(ast) && hasSubquery(ast.where);
      if (whereSubquery) {
        findings.push(
          createFinding({
            ruleId: 'sql.subquery-in-where',
            title: 'Subquery in the WHERE clause',
            severity: 'medium',
            category: 'performance',
            message: 'A subquery in WHERE can be materialized or executed repeatedly, depending on the version and plan.',
            recommendation: 'Compare the EXPLAIN plan with an equivalent JOIN or EXISTS rewrite.',
            line,
          }),
        );
      }

      for (const column of selectedColumns(ast)) {
        walk(column.expr, (current) => {
          if (
            current.type === 'binary_expr' &&
            ['LIKE', 'NOT LIKE'].includes(String(current.operator).toUpperCase())
          ) {
            const value = stringValue(current.right);
            if (value && (value.startsWith('%') || value.startsWith('_'))) {
              findings.push(
                createFinding({
                  ruleId: 'sql.leading-wildcard',
                  title: 'LIKE with a leading wildcard',
                  severity: 'medium',
                  category: 'performance',
                  message: "The pattern starts with a wildcard, so MySQL cannot use a normal B-tree index for the search.",
                  recommendation: 'Use a prefix search (LIKE \'term%\') or a dedicated full-text index.',
                  line,
                }),
              );
            }
          }
        });
      }
      walk(ast.where, (current) => {
        if (
          current.type === 'binary_expr' &&
          ['LIKE', 'NOT LIKE'].includes(String(current.operator).toUpperCase())
        ) {
          const value = stringValue(current.right);
          if (value && (value.startsWith('%') || value.startsWith('_'))) {
            findings.push(
              createFinding({
                ruleId: 'sql.leading-wildcard',
                title: 'LIKE with a leading wildcard',
                severity: 'medium',
                category: 'performance',
                message: 'The pattern starts with a wildcard, so MySQL cannot use a normal B-tree index for the search.',
                recommendation: "Use a prefix search (LIKE 'term%') or a dedicated full-text index.",
                line,
                confidence: 'high',
              }),
            );
          }
        }
      });
    }

    if ((type === 'insert' || type === 'replace') && isRecord(ast)) {
      if (ast.columns == null) {
        findings.push(
          createFinding({
            ruleId: 'sql.insert-without-columns',
            title: 'INSERT without a column list',
            severity: 'medium',
            category: 'maintainability',
            message: 'Without a column list, the statement breaks if the table gains, loses, or reorders columns.',
            recommendation: 'List the target columns explicitly.',
            line,
          }),
        );
      }
    }

    if (firstWord === 'REPLACE') {
      findings.push(
        createFinding({
          ruleId: 'sql.replace-into',
          title: 'REPLACE deletes and reinserts rows',
          severity: 'medium',
          category: 'correctness',
          message: 'REPLACE removes conflicting rows before inserting, which can break foreign keys and triggers.',
          recommendation: 'Use INSERT ... ON DUPLICATE KEY UPDATE when a true upsert is intended.',
          line,
        }),
      );
    }

    if (findSequence(tokens, ['FOR', 'UPDATE']) >= 0) {
      findings.push(
        createFinding({
          ruleId: 'sql.select-for-update',
          title: 'SELECT ... FOR UPDATE takes exclusive row locks',
          severity: 'high',
          category: 'correctness',
          message: 'Rows touched by this query are locked until the transaction ends, which can block other sessions.',
          recommendation: 'Keep the transaction short and ensure the predicate uses an index to avoid gap locks.',
          line,
        }),
      );
    } else if (
      findSequence(tokens, ['LOCK', 'IN', 'SHARE', 'MODE']) >= 0 ||
      findSequence(tokens, ['FOR', 'SHARE']) >= 0
    ) {
      findings.push(
        createFinding({
          ruleId: 'sql.lock-in-share-mode',
          title: 'Shared lock read',
          severity: 'medium',
          category: 'correctness',
          message: 'The query takes shared locks that can still block writers.',
          recommendation: 'Confirm the lock is required; prefer a plain consistent read when possible.',
          line,
        }),
      );
    }

    if (findSequence(tokens, ['SQL_CALC_FOUND_ROWS']) >= 0) {
      findings.push(
        createFinding({
          ruleId: 'sql.sql-calc-found-rows',
          title: 'SQL_CALC_FOUND_ROWS is deprecated and slow',
          severity: 'medium',
          category: 'performance',
          message: 'SQL_CALC_FOUND_ROWS often prevents efficient LIMIT handling.',
          recommendation: 'Run a separate COUNT(*) query, or use a window function on MySQL 8+/MariaDB 10.2+.',
          line,
        }),
      );
    }

    if (tokens.some((token) => ['REGEXP', 'RLIKE'].includes(tokenUpper(token)))) {
      findings.push(
        createFinding({
          ruleId: 'sql.regexp-predicate',
          title: 'Regular-expression predicate',
          severity: 'low',
          category: 'performance',
          message: 'REGEXP/RLIKE usually cannot use an index and evaluates the pattern for every candidate row.',
          recommendation: 'Use anchored LIKE prefixes or a full-text/search index when possible.',
          line,
        }),
      );
    }

    if (findSequence(tokens, ['INTO', 'OUTFILE']) >= 0 || findSequence(tokens, ['INTO', 'DUMPFILE']) >= 0) {
      findings.push(
        createFinding({
          ruleId: 'sql.into-outfile',
          title: 'SELECT writes a file on the server',
          severity: 'high',
          category: 'security',
          message: 'INTO OUTFILE/DUMPFILE writes data to the MySQL server filesystem and requires FILE privilege.',
          recommendation: 'Use a client-side export instead, and keep FILE privilege restricted.',
          line,
        }),
      );
    }

    const hasUnion = findSequence(tokens, ['UNION']) >= 0;
    if (hasUnion && findSequence(tokens, ['UNION', 'ALL']) < 0) {
      findings.push(
        createFinding({
          ruleId: 'sql.union-without-all',
          title: 'UNION deduplicates the result',
          severity: 'info',
          category: 'performance',
          message: 'UNION removes duplicates and adds a sort/hash step. UNION ALL is cheaper when duplicates are acceptable.',
          recommendation: 'Use UNION ALL if the branches cannot produce duplicates or duplicates are fine.',
          line,
        }),
      );
    }
  });

  const hasTransaction = context.tokens.some(
    (token) => token.kind === 'word' && ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(tokenUpper(token)),
  ) || findSequence(context.tokens, ['START', 'TRANSACTION']) >= 0;
  const hasDdl = context.statements.some(
    (statement) => statement.classification.kind === 'ddl',
  );
  if (hasTransaction && hasDdl) {
    findings.push(
      createFinding({
        ruleId: 'sql.ddl-in-transaction',
        title: 'DDL inside a transaction script',
        severity: 'high',
        category: 'correctness',
        message: 'MySQL performs an implicit commit before and after DDL, so it cannot be rolled back with the rest of the script.',
        recommendation: 'Keep DDL out of transactional batches and run it as its own confirmed step.',
        line: context.statements.find((statement) => statement.classification.kind === 'ddl')?.line,
        confidence: 'high',
      }),
    );
  }

  return findings;
}
