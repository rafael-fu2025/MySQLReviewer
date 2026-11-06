import type { ColumnInfo, FindingObject, SchemaTable } from '../../../shared/types';
import { defineRule, runRules, type Rule, type RuleCatalogEntry } from './descriptor';

const MONEY_NAME =
  /(amount|price|cost|balance|total|subtotal|fee|salary|payment|tax|discount|revenue|income|debit|credit|budget)/i;
const NUMERIC_INT = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
const TEXT_TYPES = new Set([
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
]);

const RESERVED_WORDS = new Set([
  'ACCESSIBLE',
  'ADD',
  'ALL',
  'ALTER',
  'ANALYZE',
  'AND',
  'AS',
  'ASC',
  'BEFORE',
  'BETWEEN',
  'BOTH',
  'BY',
  'CALL',
  'CASCADE',
  'CASE',
  'CHANGE',
  'CHARACTER',
  'CHECK',
  'COLLATE',
  'COLUMN',
  'CONDITION',
  'CONSTRAINT',
  'CONTINUE',
  'CONVERT',
  'CREATE',
  'CROSS',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'CURRENT_USER',
  'DATABASE',
  'DATABASES',
  'DECLARE',
  'DEFAULT',
  'DELAYED',
  'DELETE',
  'DESC',
  'DESCRIBE',
  'DETERMINISTIC',
  'DISTINCT',
  'DISTINCTROW',
  'DIV',
  'DOUBLE',
  'DROP',
  'DUAL',
  'EACH',
  'ELSE',
  'ELSEIF',
  'ENCLOSED',
  'ESCAPED',
  'EXISTS',
  'EXIT',
  'EXPLAIN',
  'FALSE',
  'FETCH',
  'FLOAT',
  'FOR',
  'FORCE',
  'FOREIGN',
  'FROM',
  'FULLTEXT',
  'GENERATED',
  'GRANT',
  'GROUP',
  'HAVING',
  'HIGH_PRIORITY',
  'IF',
  'IGNORE',
  'IN',
  'INDEX',
  'INFILE',
  'INNER',
  'INOUT',
  'INSERT',
  'INT',
  'INTEGER',
  'INTERVAL',
  'INTO',
  'IS',
  'ITERATE',
  'JOIN',
  'KEY',
  'KEYS',
  'KILL',
  'LEADING',
  'LEAVE',
  'LEFT',
  'LIKE',
  'LIMIT',
  'LINEAR',
  'LINES',
  'LOAD',
  'LOCALTIME',
  'LOCALTIMESTAMP',
  'LOCK',
  'LONG',
  'LOOP',
  'LOW_PRIORITY',
  'MATCH',
  'MAXVALUE',
  'MODIFIES',
  'NATURAL',
  'NOT',
  'NO_WRITE_TO_BINLOG',
  'NULL',
  'NUMERIC',
  'ON',
  'OPTIMIZE',
  'OPTION',
  'OPTIONALLY',
  'OR',
  'ORDER',
  'OUT',
  'OUTER',
  'OUTFILE',
  'PARTITION',
  'PRECISION',
  'PRIMARY',
  'PROCEDURE',
  'PURGE',
  'RANGE',
  'READ',
  'READS',
  'REAL',
  'REFERENCES',
  'REGEXP',
  'RELEASE',
  'RENAME',
  'REPEAT',
  'REPLACE',
  'REQUIRE',
  'RESTRICT',
  'RETURN',
  'REVOKE',
  'RIGHT',
  'RLIKE',
  'SCHEMA',
  'SCHEMAS',
  'SELECT',
  'SET',
  'SHOW',
  'SPATIAL',
  'SQL',
  'SQLEXCEPTION',
  'SQLSTATE',
  'SQLWARNING',
  'SSL',
  'STARTING',
  'STATUS',
  'STRAIGHT_JOIN',
  'TABLE',
  'TERMINATED',
  'THEN',
  'TO',
  'TRAILING',
  'TRIGGER',
  'TRUE',
  'UNDO',
  'UNION',
  'UNIQUE',
  'UNLOCK',
  'UNSIGNED',
  'UPDATE',
  'USAGE',
  'USE',
  'USING',
  'UTC_DATE',
  'UTC_TIME',
  'UTC_TIMESTAMP',
  'VALUES',
  'VARBINARY',
  'VARCHAR',
  'VARCHARACTER',
  'VARYING',
  'WHEN',
  'WHERE',
  'WHILE',
  'WITH',
  'WRITE',
  'XOR',
  'YEAR_MONTH',
  'ZEROFILL',
]);

export interface SchemaRuleOptions {
  serverCharset?: string | null;
}

export interface SchemaRuleInput {
  table: SchemaTable;
  options: SchemaRuleOptions;
}

function findColumn(table: SchemaTable, name: string): ColumnInfo | undefined {
  return table.columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
}

function indexCovers(table: SchemaTable, columns: string[]): boolean {
  const lower = columns.map((column) => column.toLowerCase());
  return table.indexes.some((index) => {
    if (index.columns.length < lower.length) return false;
    return lower.every((column, i) => index.columns[i].name.toLowerCase() === column);
  });
}

export const SCHEMA_RULES: Rule<SchemaRuleInput>[] = [
  defineRule<SchemaRuleInput>(
    {
      id: 'schema.no-primary-key',
      title: 'Table has no primary key',
      severity: 'high',
      category: 'schema',
    },
    ({ table }) =>
      table.indexes.some((index) => index.name.toUpperCase() === 'PRIMARY')
        ? null
        : {
            message: `\`${table.name}\` has no PRIMARY KEY, so individual rows cannot be addressed cheaply or replicated safely.`,
            recommendation:
              'Add an auto-increment or natural primary key. If the table is append-only, a composite key may fit.',
          },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.no-indexes',
      title: 'Table has no indexes',
      severity: 'high',
      category: 'schema',
    },
    ({ table }) =>
      table.indexes.length === 0
        ? {
            message: `\`${table.name}\` has no indexes at all. Every lookup scans the whole table.`,
            recommendation:
              'Add a primary key and indexes for the columns used in WHERE/JOIN/ORDER BY.',
          }
        : null,
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.fk-without-index',
      title: 'Foreign-key column is not indexed',
      severity: 'high',
      category: 'schema',
    },
    ({ table }) => {
      const hits = table.foreignKeys
        .filter((fk) => !indexCovers(table, fk.columns))
        .map((fk) => ({
          message: `Foreign key \`${fk.name}\` uses (${fk.columns.join(', ')}) but no index starts with those columns.`,
          recommendation:
            'Add an index with the foreign-key columns in the same order; MySQL needs it for parent-row checks.',
          object: { index: fk.name },
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.fk-set-null-on-not-null',
      title: 'ON DELETE SET NULL targets NOT NULL columns',
      severity: 'high',
      category: 'correctness',
    },
    ({ table }) => {
      const hits = table.foreignKeys
        .filter((fk) => fk.onDelete.toUpperCase().includes('SET NULL'))
        .map((fk) => {
          const nonNullable = fk.columns
            .map((column) => findColumn(table, column))
            .filter((column): column is ColumnInfo => Boolean(column))
            .filter((column) => !column.nullable);
          if (nonNullable.length === 0) return null;
          return {
            message: `Foreign key \`${fk.name}\` uses ON DELETE SET NULL, but ${nonNullable.map((column) => `\`${column.name}\``).join(', ')} is NOT NULL.`,
            recommendation: 'Make the columns nullable or choose RESTRICT/CASCADE semantics.',
            object: { index: fk.name },
          };
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.duplicate-index',
      title: 'Duplicate index',
      severity: 'medium',
      category: 'performance',
    },
    ({ table }) => {
      const hits = table.indexes
        .filter((index) => index.duplicateOf)
        .map((index) => ({
          message: `Index \`${index.name}\` duplicates \`${index.duplicateOf}\` on the same columns.`,
          recommendation: `Drop \`${index.name}\` unless it is required by a constraint or query hint.`,
          object: { index: index.name },
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.redundant-index',
      title: 'Redundant index prefix',
      severity: 'medium',
      category: 'performance',
    },
    ({ table }) => {
      const hits = table.indexes
        .filter((index) => index.redundantOf)
        .map((index) => ({
          message: `Index \`${index.name}\` is a leading prefix of \`${index.redundantOf}\`, so it adds write cost without unique lookup value.`,
          recommendation: `Drop \`${index.name}\` if it is not independently required.`,
          object: { index: index.name },
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.wide-index',
      title: 'Very wide index',
      severity: 'low',
      category: 'performance',
    },
    ({ table }) => {
      const hits = table.indexes
        .filter((index) => index.columns.length > 5)
        .map((index) => ({
          message: `Index \`${index.name}\` has ${index.columns.length} columns.`,
          recommendation:
            'Keep composite indexes focused on the predicates and ordering actually used by queries.',
          object: { index: index.name },
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.text-index-without-prefix',
      title: 'Text/BLOB column indexed without a prefix length',
      severity: 'medium',
      category: 'schema',
    },
    ({ table }) => {
      const hits = table.indexes
        .filter((index) => index.type === 'BTREE')
        .flatMap((index) =>
          index.columns
            .map((indexColumn) => {
              const column = findColumn(table, indexColumn.name);
              if (!column || !TEXT_TYPES.has(column.dataType) || indexColumn.subPart != null) {
                return null;
              }
              return {
                message: `Index \`${index.name}\` includes \`${column.name}\` (${column.dataType}) without a prefix length.`,
                recommendation:
                  'Use a prefix index such as `column`(191), or a FULLTEXT index for search.',
                object: { column: column.name, index: index.name },
              };
            })
            .filter((hit): hit is NonNullable<typeof hit> => hit !== null),
        );
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.too-many-indexes',
      title: 'Large number of indexes',
      severity: 'low',
      category: 'performance',
    },
    ({ table }) =>
      table.indexes.length > 8
        ? {
            message: `\`${table.name}\` has ${table.indexes.length} indexes.`,
            recommendation:
              'Review unused/duplicate indexes; every index adds write amplification and storage.',
            evidence: `${table.indexes.length} indexes`,
          }
        : null,
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.non-innodb-engine',
      title: 'Table does not use InnoDB',
      severity: 'high',
      category: 'schema',
    },
    ({ table }) =>
      table.engine && table.engine.toUpperCase() !== 'INNODB'
        ? {
            message: `Engine is ${table.engine}; transactions, foreign keys, and crash recovery differ.`,
            recommendation: 'Convert the table to InnoDB unless the engine choice is deliberate.',
            evidence: `engine=${table.engine}`,
          }
        : null,
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.utf8mb3',
      title: 'utf8mb3 / utf8 alias limits characters',
      severity: 'medium',
      category: 'schema',
    },
    ({ table }) => {
      const charset = table.charset ?? table.collation?.split('_')[0] ?? null;
      if (!charset || (charset !== 'utf8' && charset !== 'utf8mb3')) return null;
      return {
        message: `\`${table.name}\` uses ${charset}, which cannot store 4-byte characters such as emoji.`,
        recommendation: 'Convert to utf8mb4 and a matching utf8mb4 collation.',
        evidence: `collation=${table.collation ?? 'unknown'}`,
      };
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.latin1-charset',
      title: 'latin1 charset is too narrow',
      severity: 'medium',
      category: 'schema',
    },
    ({ table }) => {
      const charset = table.charset ?? table.collation?.split('_')[0] ?? null;
      if (charset !== 'latin1') return null;
      return {
        message: `\`${table.name}\` uses latin1 and cannot represent most non-Western text.`,
        recommendation: 'Convert to utf8mb4 after verifying client compatibility.',
        evidence: `collation=${table.collation ?? 'unknown'}`,
      };
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.charset-mismatch',
      title: 'Table charset differs from the server default',
      severity: 'low',
      category: 'schema',
    },
    ({ table, options }) => {
      const charset = table.charset ?? table.collation?.split('_')[0] ?? null;
      if (!options.serverCharset || !charset) return null;
      if (charset.toLowerCase() === options.serverCharset.toLowerCase()) return null;
      return {
        message: `Table charset ${charset} differs from server charset ${options.serverCharset}; joins may require conversion.`,
        recommendation: 'Normalize charsets/collations across related tables.',
        evidence: `table=${charset} server=${options.serverCharset}`,
      };
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.float-for-money',
      title: 'Floating-point type used for a money-like column',
      severity: 'high',
      category: 'correctness',
    },
    ({ table }) => {
      const hits = table.columns
        .filter(
          (column) =>
            ['float', 'double', 'real'].includes(column.dataType) && MONEY_NAME.test(column.name),
        )
        .map((column) => ({
          message: `\`${column.name}\` is ${column.columnType}; floating-point arithmetic is not exact for currency.`,
          recommendation:
            'Use DECIMAL(p, 2) (or a currency-specific scale) and store amounts as exact values.',
          object: { column: column.name },
          confidence: 'medium' as const,
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.varchar-too-long',
      title: 'Very large VARCHAR',
      severity: 'low',
      category: 'schema',
    },
    ({ table }) => {
      const hits = table.columns
        .filter((column) => {
          if (column.dataType !== 'varchar' && column.dataType !== 'char') return false;
          if (!column.columnType) return false;
          const match = column.columnType.match(/\((\d+)\)/);
          const length = match ? Number.parseInt(match[1], 10) : 0;
          return length > 1024;
        })
        .map((column) => ({
          message: `\`${column.name}\` is ${column.columnType}.`,
          recommendation:
            'Use TEXT/BLOB or a narrower limit if the full length is rarely used; large VARCHARs affect row size and memory.',
          object: { column: column.name },
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.column-charset-mismatch',
      title: 'Column charset differs from the table charset',
      severity: 'low',
      category: 'schema',
    },
    ({ table }) => {
      const charset = table.charset ?? table.collation?.split('_')[0] ?? null;
      if (!charset) return null;
      const hits = table.columns
        .filter(
          (column) =>
            Boolean(column.charset) && column.charset!.toLowerCase() !== charset.toLowerCase(),
        )
        .map((column) => ({
          message: `\`${column.name}\` uses ${column.charset} while the table uses ${charset}.`,
          recommendation:
            'Normalize column charsets to the table charset unless there is a specific reason.',
          object: { column: column.name },
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.reserved-column-name',
      title: 'Column name is a MySQL reserved word',
      severity: 'low',
      category: 'maintainability',
    },
    ({ table }) => {
      const hits = table.columns
        .filter((column) => RESERVED_WORDS.has(column.name.toUpperCase()))
        .map((column) => ({
          message: `\`${column.name}\` is reserved by MySQL and must always be quoted.`,
          recommendation: 'Rename the column or consistently quote it; prefer a non-reserved name.',
          object: { column: column.name },
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.identifier-case',
      title: 'Mixed-case identifier',
      severity: 'low',
      category: 'maintainability',
    },
    ({ table }) => {
      const hits = table.columns
        .filter((column) => /[A-Z]/.test(column.name))
        .map((column) => ({
          message: `\`${column.name}\` contains uppercase letters; identifier case sensitivity varies by platform.`,
          recommendation: 'Prefer lowercase snake_case identifiers for portability.',
          object: { column: column.name },
          confidence: 'medium' as const,
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.not-null-without-default',
      title: 'NOT NULL column has no default',
      severity: 'info',
      category: 'maintainability',
    },
    ({ table }) => {
      const hits = table.columns
        .filter(
          (column) =>
            !column.nullable &&
            column.defaultValue == null &&
            column.extra === '' &&
            column.key === '' &&
            column.generationExpression == null,
        )
        .map((column) => ({
          message: `\`${column.name}\` is NOT NULL with no default; INSERTs must always provide a value.`,
          recommendation: 'Add a default or ensure every INSERT lists the column.',
          object: { column: column.name },
          confidence: 'low' as const,
        }));
      return hits.length > 0 ? hits : null;
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.reserved-table-name',
      title: 'Table name is a MySQL reserved word',
      severity: 'low',
      category: 'maintainability',
    },
    ({ table }) =>
      RESERVED_WORDS.has(table.name.toUpperCase())
        ? {
            message: `\`${table.name}\` is reserved by MySQL and must always be quoted.`,
            recommendation: 'Rename the table or consistently quote it.',
          }
        : null,
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.identifier-case-table',
      title: 'Mixed-case table name',
      severity: 'low',
      category: 'maintainability',
    },
    ({ table }) =>
      /[A-Z]/.test(table.name)
        ? {
            message: `\`${table.name}\` contains uppercase letters; lower_case_table_names differs between Windows and Linux.`,
            recommendation: 'Prefer lowercase snake_case table names.',
            confidence: 'medium' as const,
          }
        : null,
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.long-table-name',
      title: 'Long table name',
      severity: 'low',
      category: 'maintainability',
    },
    ({ table }) =>
      table.name.length > 60
        ? {
            message: `\`${table.name}\` is ${table.name.length} characters long.`,
            recommendation:
              'Keep table names short enough to remain readable in queries and tools.',
          }
        : null,
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.too-many-columns',
      title: 'Very wide table',
      severity: 'low',
      category: 'schema',
    },
    ({ table }) =>
      table.columns.length > 50
        ? {
            message: `\`${table.name}\` has ${table.columns.length} columns.`,
            recommendation:
              'Consider splitting optional or rarely used columns into a related table.',
            confidence: 'medium' as const,
          }
        : null,
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.non-auto-increment-pk',
      title: 'Integer primary key is not auto-increment',
      severity: 'info',
      category: 'schema',
    },
    ({ table }) => {
      const primary = table.indexes.find((index) => index.name.toUpperCase() === 'PRIMARY');
      if (!primary || primary.columns.length !== 1) return null;
      const pkColumn = findColumn(table, primary.columns[0].name);
      if (!pkColumn || !NUMERIC_INT.has(pkColumn.dataType)) return null;
      if (pkColumn.extra.toLowerCase().includes('auto_increment')) return null;
      return {
        message: `Primary key \`${pkColumn.name}\` is an integer without AUTO_INCREMENT.`,
        recommendation:
          'Confirm the application always supplies unique values; AUTO_INCREMENT is usually simpler for surrogate keys.',
        object: { column: pkColumn.name },
        confidence: 'low' as const,
      };
    },
  ),

  defineRule<SchemaRuleInput>(
    {
      id: 'schema.table-fragmentation',
      title: 'Table has significant free space',
      severity: 'low',
      category: 'performance',
    },
    ({ table }) =>
      table.dataFreeBytes > 10 * 1024 * 1024 && table.dataFreeBytes > table.dataBytes * 0.2
        ? {
            message: `\`${table.name}\` reports ${Math.round(table.dataFreeBytes / 1024 / 1024)} MB of free space.`,
            recommendation:
              'OPTIMIZE TABLE can reclaim space, but schedule it carefully on large or busy tables.',
            confidence: 'medium' as const,
          }
        : null,
  ),
];

export function runSchemaRules(table: SchemaTable, options: SchemaRuleOptions = {}) {
  const base: FindingObject = { database: table.database, table: table.name };
  // Every finding is anchored to the table it describes; rules may narrow the
  // object further with a column or index.
  return runRules(SCHEMA_RULES, { table, options }).map((finding) => ({
    ...finding,
    object: { ...base, ...finding.object },
  }));
}

/**
 * The catalog entry for the unused-index finding.
 *
 * The finding is produced by the audit from the server's index-usage
 * statistics (`server/review/audit.ts`), not from a schema snapshot, so it has
 * no rule module of its own. It is registered here so the catalog stays a
 * complete list of the rule ids the engine can emit.
 */
export const UNUSED_INDEX_RULE: RuleCatalogEntry = {
  id: 'schema.unused-index',
  title: 'Index has not been used since statistics reset',
  severity: 'low',
  category: 'performance',
  module: 'schema',
};
