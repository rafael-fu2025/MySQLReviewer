import { describe, expect, it } from 'vitest';
import type { CellValue, QueryColumn } from '@shared/types';
import {
  compareCellValues,
  filterRows,
  formatDuration,
  isNumericLike,
  sortRows,
  toMarkdownTable,
  toSqlInsert,
  toTsv,
} from '../src/lib/format';

describe('formatDuration', () => {
  it('returns a dash for a missing value', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('keeps sub-millisecond precision', () => {
    expect(formatDuration(0.25)).toBe('250 µs');
  });

  it('keeps milliseconds readable', () => {
    expect(formatDuration(4.25)).toBe('4.3 ms');
    expect(formatDuration(250)).toBe('250 ms');
  });

  it('switches to seconds past a second', () => {
    expect(formatDuration(1500)).toBe('1.50 s');
  });

  it('switches to minutes past a minute', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('switches to hours past an hour instead of counting minutes', () => {
    // 2h 3m 4s used to print as "123m 4s".
    expect(formatDuration((2 * 3600 + 3 * 60 + 4) * 1000)).toBe('2h 3m');
  });

  it('switches to days past a day', () => {
    // An uptime of 34h 32m used to print as "2072m 41s".
    expect(formatDuration((34 * 3600 + 32 * 60 + 41) * 1000)).toBe('1d 11h');
  });

  it('never carries a rounded unit into the next one', () => {
    // 59m 59.6s rounds up to 60 minutes, which must stay "60m 0s".
    expect(formatDuration(3_599_600)).toBe('60m 0s');
    // 23h 59m 40s rounds up to 24 hours, which must stay "24h 0m".
    expect(formatDuration(86_380_000)).toBe('24h 0m');
  });
});

const columns: QueryColumn[] = [
  {
    name: 'CustomerID',
    originalName: 'CustomerID',
    table: 'customers',
    database: 'northwind',
    typeName: 'INT',
    typeCode: 3,
    flags: 0,
  },
  {
    name: 'CustomerName',
    originalName: 'CustomerName',
    table: 'customers',
    database: 'northwind',
    typeName: 'VARCHAR',
    typeCode: 253,
    flags: 0,
  },
  {
    name: 'Country',
    originalName: 'Country',
    table: 'customers',
    database: 'northwind',
    typeName: 'VARCHAR',
    typeCode: 253,
    flags: 0,
  },
];

describe('isNumericLike', () => {
  it('accepts finite numbers and numeric strings', () => {
    expect(isNumericLike(42)).toBe(true);
    expect(isNumericLike(-3.5)).toBe(true);
    expect(isNumericLike('42')).toBe(true);
    expect(isNumericLike(' 3.14 ')).toBe(true);
    expect(isNumericLike('-7')).toBe(true);
    expect(isNumericLike('+2')).toBe(true);
    expect(isNumericLike('.5')).toBe(true);
    expect(isNumericLike('1e3')).toBe(true);
  });

  it('rejects prose, masked cells, blanks and non-finite numbers', () => {
    expect(isNumericLike('')).toBe(false);
    expect(isNumericLike('   ')).toBe(false);
    expect(isNumericLike('abc')).toBe(false);
    expect(isNumericLike('12a')).toBe(false);
    expect(isNumericLike('••••••••')).toBe(false);
    expect(isNumericLike(Number.NaN)).toBe(false);
    expect(isNumericLike(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNumericLike(null)).toBe(false);
    expect(isNumericLike(true)).toBe(false);
  });
});

describe('compareCellValues', () => {
  it('compares numeric-like cells by value, not by text', () => {
    expect(compareCellValues(10, 9)).toBeGreaterThan(0);
    expect(compareCellValues('10', '9')).toBeGreaterThan(0);
    expect(compareCellValues('10', 9)).toBeGreaterThan(0);
    expect(compareCellValues(2, 10)).toBeLessThan(0);
    expect(compareCellValues('1e3', 1000)).toBe(0);
  });

  it('compares non-numeric cells as text, including masked cells', () => {
    expect(compareCellValues('apple', 'banana')).toBeLessThan(0);
    expect(compareCellValues('b', 'a')).toBeGreaterThan(0);
    // A masked cell ("••••••••") is a string like any other, never a number:
    // it compares exactly as localeCompare would.
    expect(compareCellValues('••••••••', '9')).toBe('••••••••'.localeCompare('9'));
  });

  it('sorts nulls and binary cells last whatever the direction', () => {
    const binary = { __type: 'binary' as const, length: 4, previewHex: 'dead', truncated: false };
    for (const dir of ['asc', 'desc'] as const) {
      expect(compareCellValues(null, 'a', dir)).toBeGreaterThan(0);
      expect(compareCellValues(binary, 'a', dir)).toBeGreaterThan(0);
      expect(compareCellValues('a', null, dir)).toBeLessThan(0);
    }
    expect(compareCellValues(null, null)).toBe(0);
    expect(compareCellValues(binary, null)).toBe(0);
  });

  it('flips the informative comparison for descending order', () => {
    expect(compareCellValues(1, 2, 'asc')).toBeLessThan(0);
    expect(compareCellValues(1, 2, 'desc')).toBeGreaterThan(0);
    expect(compareCellValues('a', 'b', 'desc')).toBeGreaterThan(0);
  });
});

describe('sortRows', () => {
  it('orders a copy of the full set without mutating the input', () => {
    const input: number[][] = [[3], [1], [2]];
    const sorted = sortRows(input, 0, 'asc');
    expect(sorted.map((row) => row[0])).toEqual([1, 2, 3]);
    expect(input.map((row) => row[0])).toEqual([3, 1, 2]);
  });

  it('keeps ties in their original order', () => {
    const input: CellValue[][] = [
      [2, 'b'],
      [1, 'a'],
      [2, 'a'],
    ];
    expect(sortRows(input, 0, 'asc').map((row) => row[1])).toEqual(['a', 'b', 'a']);
  });

  it('sorts numeric strings numerically and masked strings as strings', () => {
    const input = [['10'], ['9'], ['••••••••'], [null]];
    // '9' and '10' compare by value; the masked string compares as text
    // (punctuation collates before alphanumerics); NULL stays last.
    expect(sortRows(input, 0, 'asc').map((row) => row[0])).toEqual(['••••••••', '9', '10', null]);
    expect(sortRows(input, 0, 'desc').map((row) => row[0])).toEqual(['10', '9', '••••••••', null]);
  });

  it('treats a missing cell as last, like a NULL', () => {
    expect(sortRows([[], [5], []], 0, 'asc').map((row) => row[0] ?? null)).toEqual([5, null, null]);
  });
});

describe('filterRows', () => {
  const rows = [
    ['Alfreds Futterkiste', 'Germany'],
    ['Ana Trujillo', 'Mexico'],
    [42, null],
  ];

  it('matches case-insensitively across every cell', () => {
    expect(filterRows(rows, 'germany')).toEqual([rows[0]]);
    expect(filterRows(rows, 'TRUJILLO')).toEqual([rows[1]]);
    expect(filterRows(rows, '42')).toEqual([rows[2]]);
  });

  it('matches masked cells by their masked form', () => {
    const masked = [['••••••••'], ['plain']];
    expect(filterRows(masked, '••••')).toEqual([['••••••••']]);
  });

  it('returns the original array for an empty or blank filter', () => {
    expect(filterRows(rows, '')).toBe(rows);
    expect(filterRows(rows, '   ')).toBe(rows);
  });
});

describe('toTsv', () => {
  it('writes a header row and one line per row', () => {
    expect(toTsv(columns, [[1, 'Alfreds Futterkiste', 'Germany']])).toBe(
      'CustomerID\tCustomerName\tCountry\n1\tAlfreds Futterkiste\tGermany',
    );
  });

  it('escapes tabs, newlines and backslashes inside a value', () => {
    expect(toTsv([columns[0]], [['a\tb\nc\\d']])).toBe('CustomerID\na\\tb\\nc\\\\d');
  });

  it('copies masked and NULL cells as they are displayed', () => {
    expect(toTsv([columns[0]], [['••••••••']])).toBe('CustomerID\n••••••••');
    expect(toTsv([columns[0]], [[null]])).toBe('CustomerID\nNULL');
  });
});

describe('toMarkdownTable', () => {
  it('writes the header, the |---| divider and one row per line', () => {
    expect(toMarkdownTable([columns[0], columns[1]], [[1, 'Alfreds Futterkiste']])).toBe(
      '| CustomerID | CustomerName |\n| --- | --- |\n| 1 | Alfreds Futterkiste |',
    );
  });

  it('escapes pipes and turns newlines into <br>', () => {
    expect(toMarkdownTable([columns[0]], [['a|b\nc']])).toBe(
      '| CustomerID |\n| --- |\n| a\\|b<br>c |',
    );
  });
});

describe('toSqlInsert', () => {
  it('takes the table name from the result metadata and backtick-quotes identifiers', () => {
    const sql = toSqlInsert({ database: 'northwind', table: 'customers' }, columns, [
      [1, 'a', 'b'],
    ]);
    expect(sql).toBe(
      "INSERT INTO `northwind`.`customers` (`CustomerID`, `CustomerName`, `Country`) VALUES\n  (1, 'a', 'b');",
    );
  });

  it('doubles quotes and escapes backslashes inside string values', () => {
    const sql = toSqlInsert({ database: null, table: 'customers' }, columns, [
      [42, "it's a\\b", null],
    ]);
    expect(sql).toBe(
      "INSERT INTO `customers` (`CustomerID`, `CustomerName`, `Country`) VALUES\n  (42, 'it''s a\\\\b', NULL);",
    );
  });

  it('writes numbers bare and booleans as TRUE and FALSE', () => {
    const sql = toSqlInsert({ database: null, table: 't' }, columns, [[42, true, false]]);
    expect(sql).toContain('(42, TRUE, FALSE)');
  });

  it('serializes objects and arrays as JSON strings and binary cells as hex literals', () => {
    const binary = { __type: 'binary' as const, length: 2, previewHex: 'dead', truncated: false };
    const truncated = {
      __type: 'binary' as const,
      length: 128,
      previewHex: 'ff',
      truncated: true,
    };
    const sql = toSqlInsert({ database: null, table: 't' }, columns, [[{ a: 1 }, [1, 2], binary]]);
    expect(sql).toContain("('{\"a\":1}', '[1,2]', X'dead')");
    const truncatedSql = toSqlInsert({ database: null, table: 't' }, columns, [[1, 2, truncated]]);
    expect(truncatedSql).toContain("X'ff' /* preview of 128 bytes */");
  });

  it('falls back to a my_table placeholder with a replace comment when no table is known', () => {
    const computed: QueryColumn[] = [{ ...columns[0], table: null, database: null }];
    const sql = toSqlInsert(null, computed, [[5]]);
    expect(sql.startsWith('-- replace table name\n')).toBe(true);
    expect(sql).toContain('INSERT INTO `my_table` (`CustomerID`) VALUES\n  (5);');
  });

  it('doubles backticks in identifiers', () => {
    const weird: QueryColumn[] = [
      { ...columns[0], name: 'we`ird', table: 'ta`ble', database: null },
    ];
    expect(toSqlInsert({ database: null, table: 'ta`ble' }, weird, [[1]])).toBe(
      'INSERT INTO `ta``ble` (`we``ird`) VALUES\n  (1);',
    );
  });

  it('emits one multi-row insert for pages of at most 100 rows', () => {
    const rows = Array.from({ length: 100 }, (_, index) => [index + 1, 'a', 'b']);
    const sql = toSqlInsert({ database: null, table: 't' }, columns, rows);
    expect(sql.split('INSERT INTO').length - 1).toBe(1);
    expect(sql.split(');').length - 1).toBe(1);
  });

  it('switches to one insert per row beyond 100 rows', () => {
    const rows = Array.from({ length: 101 }, (_, index) => [index + 1, 'a', 'b']);
    const sql = toSqlInsert({ database: null, table: 't' }, columns, rows);
    expect(sql.split('INSERT INTO').length - 1).toBe(101);
    expect(sql.endsWith(');')).toBe(true);
  });

  it('writes nothing for an empty page', () => {
    expect(toSqlInsert({ database: null, table: 't' }, columns, [])).toBe('');
  });
});
