import type { ColumnInfo, Finding, SchemaTable } from '../../../shared/types';
import { createFinding } from '../findings';

const MONEY_NAME = /(amount|price|cost|balance|total|subtotal|fee|salary|payment|tax|discount|revenue|income|debit|credit|budget)/i;
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

export function runSchemaRules(
  table: SchemaTable,
  options: SchemaRuleOptions = {},
): Finding[] {
  const findings: Finding[] = [];
  const object = { database: table.database, table: table.name };
  const add = (
    ruleId: string,
    title: string,
    severity: Finding['severity'],
    category: Finding['category'],
    message: string,
    recommendation: string,
    extra?: {
      column?: string;
      index?: string;
      evidence?: string;
      confidence?: Finding['confidence'];
    },
  ): void => {
    findings.push(
      createFinding({
        ruleId,
        title,
        severity,
        category,
        message,
        recommendation,
        line: null,
        object: {
          ...object,
          ...(extra?.column ? { column: extra.column } : {}),
          ...(extra?.index ? { index: extra.index } : {}),
        },
        evidence: extra?.evidence,
        source: 'rule',
        confidence: extra?.confidence ?? 'high',
      }),
    );
  };

  const primary = table.indexes.find((index) => index.name.toUpperCase() === 'PRIMARY');
  if (!primary) {
    add(
      'schema.no-primary-key',
      'Table has no primary key',
      'high',
      'schema',
      `\`${table.name}\` has no PRIMARY KEY, so individual rows cannot be addressed cheaply or replicated safely.`,
      'Add an auto-increment or natural primary key. If the table is append-only, a composite key may fit.',
    );
  }

  if (table.indexes.length === 0) {
    add(
      'schema.no-indexes',
      'Table has no indexes',
      'high',
      'schema',
      `\`${table.name}\` has no indexes at all. Every lookup scans the whole table.`,
      'Add a primary key and indexes for the columns used in WHERE/JOIN/ORDER BY.',
    );
  }

  for (const fk of table.foreignKeys) {
    if (!indexCovers(table, fk.columns)) {
      add(
        'schema.fk-without-index',
        'Foreign-key column is not indexed',
        'high',
        'schema',
        `Foreign key \`${fk.name}\` uses (${fk.columns.join(', ')}) but no index starts with those columns.`,
        'Add an index with the foreign-key columns in the same order; MySQL needs it for parent-row checks.',
        { index: fk.name },
      );
    }
    if (fk.onDelete.toUpperCase().includes('SET NULL')) {
      const nonNullable = fk.columns
        .map((column) => findColumn(table, column))
        .filter((column): column is ColumnInfo => Boolean(column))
        .filter((column) => !column.nullable);
      if (nonNullable.length > 0) {
        add(
          'schema.fk-set-null-on-not-null',
          'ON DELETE SET NULL targets NOT NULL columns',
          'high',
          'correctness',
          `Foreign key \`${fk.name}\` uses ON DELETE SET NULL, but ${nonNullable.map((column) => `\`${column.name}\``).join(', ')} is NOT NULL.`,
          'Make the columns nullable or choose RESTRICT/CASCADE semantics.',
          { index: fk.name },
        );
      }
    }
  }

  for (const index of table.indexes) {
    if (index.duplicateOf) {
      add(
        'schema.duplicate-index',
        'Duplicate index',
        'medium',
        'performance',
        `Index \`${index.name}\` duplicates \`${index.duplicateOf}\` on the same columns.`,
        `Drop \`${index.name}\` unless it is required by a constraint or query hint.`,
        { index: index.name },
      );
    }
    if (index.redundantOf) {
      add(
        'schema.redundant-index',
        'Redundant index prefix',
        'medium',
        'performance',
        `Index \`${index.name}\` is a leading prefix of \`${index.redundantOf}\`, so it adds write cost without unique lookup value.`,
        `Drop \`${index.name}\` if it is not independently required.`,
        { index: index.name },
      );
    }
    if (index.columns.length > 5) {
      add(
        'schema.wide-index',
        'Very wide index',
        'low',
        'performance',
        `Index \`${index.name}\` has ${index.columns.length} columns.`,
        'Keep composite indexes focused on the predicates and ordering actually used by queries.',
        { index: index.name },
      );
    }
    if (index.type === 'BTREE') {
      for (const indexColumn of index.columns) {
        const column = findColumn(table, indexColumn.name);
        if (column && TEXT_TYPES.has(column.dataType) && indexColumn.subPart == null) {
          add(
            'schema.text-index-without-prefix',
            'Text/BLOB column indexed without a prefix length',
            'medium',
            'schema',
            `Index \`${index.name}\` includes \`${column.name}\` (${column.dataType}) without a prefix length.`,
            'Use a prefix index such as `column`(191), or a FULLTEXT index for search.',
            { column: column.name, index: index.name },
          );
        }
      }
    }
  }

  if (table.indexes.length > 8) {
    add(
      'schema.too-many-indexes',
      'Large number of indexes',
      'low',
      'performance',
      `\`${table.name}\` has ${table.indexes.length} indexes.`,
      'Review unused/duplicate indexes; every index adds write amplification and storage.',
      { evidence: `${table.indexes.length} indexes` },
    );
  }

  if (table.engine && table.engine.toUpperCase() !== 'INNODB') {
    add(
      'schema.non-innodb-engine',
      'Table does not use InnoDB',
      'high',
      'schema',
      `Engine is ${table.engine}; transactions, foreign keys, and crash recovery differ.`,
      'Convert the table to InnoDB unless the engine choice is deliberate.',
      { evidence: `engine=${table.engine}` },
    );
  }

  const charset = table.charset ?? table.collation?.split('_')[0] ?? null;
  if (charset && (charset === 'utf8' || charset === 'utf8mb3')) {
    add(
      'schema.utf8mb3',
      'utf8mb3 / utf8 alias limits characters',
      'medium',
      'schema',
      `\`${table.name}\` uses ${charset}, which cannot store 4-byte characters such as emoji.`,
      'Convert to utf8mb4 and a matching utf8mb4 collation.',
      { evidence: `collation=${table.collation ?? 'unknown'}` },
    );
  }
  if (charset && charset === 'latin1') {
    add(
      'schema.latin1-charset',
      'latin1 charset is too narrow',
      'medium',
      'schema',
      `\`${table.name}\` uses latin1 and cannot represent most non-Western text.`,
      'Convert to utf8mb4 after verifying client compatibility.',
      { evidence: `collation=${table.collation ?? 'unknown'}` },
    );
  }
  if (
    options.serverCharset &&
    charset &&
    charset.toLowerCase() !== options.serverCharset.toLowerCase()
  ) {
    add(
      'schema.charset-mismatch',
      'Table charset differs from the server default',
      'low',
      'schema',
      `Table charset ${charset} differs from server charset ${options.serverCharset}; joins may require conversion.`,
      'Normalize charsets/collations across related tables.',
      { evidence: `table=${charset} server=${options.serverCharset}` },
    );
  }

  for (const column of table.columns) {
    const type = column.dataType;
    if (
      ['float', 'double', 'real'].includes(type) &&
      MONEY_NAME.test(column.name)
    ) {
      add(
        'schema.float-for-money',
        'Floating-point type used for a money-like column',
        'high',
        'correctness',
        `\`${column.name}\` is ${column.columnType}; floating-point arithmetic is not exact for currency.`,
        'Use DECIMAL(p, 2) (or a currency-specific scale) and store amounts as exact values.',
        { column: column.name, confidence: 'medium' },
      );
    }

    if ((type === 'varchar' || type === 'char') && column.columnType) {
      const match = column.columnType.match(/\((\d+)\)/);
      const length = match ? Number.parseInt(match[1], 10) : 0;
      if (length > 1024) {
        add(
          'schema.varchar-too-long',
          'Very large VARCHAR',
          'low',
          'schema',
          `\`${column.name}\` is ${column.columnType}.`,
          'Use TEXT/BLOB or a narrower limit if the full length is rarely used; large VARCHARs affect row size and memory.',
          { column: column.name },
        );
      }
    }

    if (column.charset && charset && column.charset.toLowerCase() !== charset.toLowerCase()) {
      add(
        'schema.column-charset-mismatch',
        'Column charset differs from the table charset',
        'low',
        'schema',
        `\`${column.name}\` uses ${column.charset} while the table uses ${charset}.`,
        'Normalize column charsets to the table charset unless there is a specific reason.',
        { column: column.name },
      );
    }

    if (RESERVED_WORDS.has(column.name.toUpperCase())) {
      add(
        'schema.reserved-column-name',
        'Column name is a MySQL reserved word',
        'low',
        'maintainability',
        `\`${column.name}\` is reserved by MySQL and must always be quoted.`,
        'Rename the column or consistently quote it; prefer a non-reserved name.',
        { column: column.name },
      );
    }

    if (/[A-Z]/.test(column.name)) {
      add(
        'schema.identifier-case',
        'Mixed-case identifier',
        'low',
        'maintainability',
        `\`${column.name}\` contains uppercase letters; identifier case sensitivity varies by platform.`,
        'Prefer lowercase snake_case identifiers for portability.',
        { column: column.name, confidence: 'medium' },
      );
    }

    if (!column.nullable && column.defaultValue == null && column.extra === '' && column.key === '' && column.generationExpression == null) {
      // Informational: NOT NULL without a default can cause strict-mode insert errors.
      add(
        'schema.not-null-without-default',
        'NOT NULL column has no default',
        'info',
        'maintainability',
        `\`${column.name}\` is NOT NULL with no default; INSERTs must always provide a value.`,
        'Add a default or ensure every INSERT lists the column.',
        { column: column.name, confidence: 'low' },
      );
    }
  }

  if (RESERVED_WORDS.has(table.name.toUpperCase())) {
    add(
      'schema.reserved-table-name',
      'Table name is a MySQL reserved word',
      'low',
      'maintainability',
      `\`${table.name}\` is reserved by MySQL and must always be quoted.`,
      'Rename the table or consistently quote it.',
    );
  }

  if (/[A-Z]/.test(table.name)) {
    add(
      'schema.identifier-case-table',
      'Mixed-case table name',
      'low',
      'maintainability',
      `\`${table.name}\` contains uppercase letters; lower_case_table_names differs between Windows and Linux.`,
      'Prefer lowercase snake_case table names.',
      { confidence: 'medium' },
    );
  }

  if (table.name.length > 60) {
    add(
      'schema.long-table-name',
      'Long table name',
      'low',
      'maintainability',
      `\`${table.name}\` is ${table.name.length} characters long.`,
      'Keep table names short enough to remain readable in queries and tools.',
    );
  }

  if (table.columns.length > 50) {
    add(
      'schema.too-many-columns',
      'Very wide table',
      'low',
      'schema',
      `\`${table.name}\` has ${table.columns.length} columns.`,
      'Consider splitting optional or rarely used columns into a related table.',
      { confidence: 'medium' },
    );
  }

  if (
    primary &&
    primary.columns.length === 1 &&
    NUMERIC_INT.has(findColumn(table, primary.columns[0].name)?.dataType ?? '')
  ) {
    const pkColumn = findColumn(table, primary.columns[0].name);
    if (pkColumn && !pkColumn.extra.toLowerCase().includes('auto_increment')) {
      add(
        'schema.non-auto-increment-pk',
        'Integer primary key is not auto-increment',
        'info',
        'schema',
        `Primary key \`${pkColumn.name}\` is an integer without AUTO_INCREMENT.`,
        'Confirm the application always supplies unique values; AUTO_INCREMENT is usually simpler for surrogate keys.',
        { column: pkColumn.name, confidence: 'low' },
      );
    }
  }

  if (table.dataFreeBytes > 10 * 1024 * 1024 && table.dataFreeBytes > table.dataBytes * 0.2) {
    add(
      'schema.table-fragmentation',
      'Table has significant free space',
      'low',
      'performance',
      `\`${table.name}\` reports ${Math.round(table.dataFreeBytes / 1024 / 1024)} MB of free space.`,
      'OPTIMIZE TABLE can reclaim space, but schedule it carefully on large or busy tables.',
      { confidence: 'medium' },
    );
  }

  return findings;
}
