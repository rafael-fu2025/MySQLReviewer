import { describe, expect, it } from 'vitest';
import type { CellValue, QueryColumn } from '@shared/types';
import {
  defaultChartConfig,
  MAX_BUCKETS,
  OTHER_LABEL,
  prepareChartData,
  type ChartConfig,
} from '@/lib/chart-data';

/**
 * The pure half of query-result charting: bucketing, aggregation math, the
 * masked-value rule, the bucket cap, the defaults and the ordering policy.
 * Everything here is DOM-free — the SVG renderer reads the same series.
 */

function column(name: string, typeName = 'VARCHAR'): QueryColumn {
  return { name, originalName: name, table: 't', database: 'd', typeName, typeCode: 253, flags: 0 };
}

function chart(columns: QueryColumn[], rows: CellValue[][]) {
  return { columns, rows };
}

const SALES = [column('Country'), column('Sales', 'INT')];

const salesRows: CellValue[][] = [
  ['Germany', 10],
  ['Germany', 20],
  ['Mexico', 5],
  ['Germany', '30'],
  ['Mexico', null],
];

function run(columns: QueryColumn[], rows: CellValue[][], config: ChartConfig) {
  return prepareChartData(chart(columns, rows), config);
}

describe('aggregation buckets', () => {
  it('counts rows per X value, whatever the Y column holds', () => {
    const series = run(SALES, salesRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'count' });
    expect(series.kind).toBe('buckets');
    if (series.kind !== 'buckets') return;
    expect(series.agg).toBe('count');
    expect(series.yLabel).toBe('Count');
    expect(Object.fromEntries(series.buckets.map((b) => [b.label, b.value]))).toEqual({
      Germany: 3,
      Mexico: 2,
    });
  });

  it('sums, averages, minimizes and maximizes the numeric-like Y values', () => {
    const sum = run(SALES, salesRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'sum' });
    if (sum.kind !== 'buckets') return;
    expect(Object.fromEntries(sum.buckets.map((b) => [b.label, b.value]))).toEqual({
      Germany: 60,
      Mexico: 5,
    });

    const avg = run(SALES, salesRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'avg' });
    if (avg.kind !== 'buckets') return;
    expect(Object.fromEntries(avg.buckets.map((b) => [b.label, b.value]))).toEqual({
      Germany: 20,
      Mexico: 5,
    });

    const min = run(SALES, salesRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'min' });
    if (min.kind !== 'buckets') return;
    expect(Object.fromEntries(min.buckets.map((b) => [b.label, b.value]))).toEqual({
      Germany: 10,
      Mexico: 5,
    });

    const max = run(SALES, salesRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'max' });
    if (max.kind !== 'buckets') return;
    expect(Object.fromEntries(max.buckets.map((b) => [b.label, b.value]))).toEqual({
      Germany: 30,
      Mexico: 5,
    });
  });

  it('buckets by the displayed cell text, so NULL and objects group cleanly', () => {
    const rows: CellValue[][] = [
      [null, 1],
      [null, 2],
      [{ a: 1 }, 3],
    ];
    const series = run(SALES, rows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'count' });
    if (series.kind !== 'buckets') return;
    expect(Object.fromEntries(series.buckets.map((b) => [b.label, b.value]))).toEqual({
      NULL: 2,
      '{"a":1}': 1,
    });
  });
});

describe('masked and non-numeric exclusion', () => {
  const maskedRows: CellValue[][] = [
    ['Germany', 10],
    ['Germany', '••••••••'],
    ['France', '••••••••'],
  ];

  it('excludes masked strings from the numeric aggregates', () => {
    const series = run(SALES, maskedRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'sum' });
    if (series.kind !== 'buckets') return;
    // Germany keeps its one real value; France has none and drops out.
    expect(series.buckets).toEqual([{ label: 'Germany', value: 10, count: 2 }]);
  });

  it('still counts rows when the aggregation is count', () => {
    const series = run(SALES, maskedRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'count' });
    if (series.kind !== 'buckets') return;
    expect(Object.fromEntries(series.buckets.map((b) => [b.label, b.value]))).toEqual({
      Germany: 2,
      France: 1,
    });
  });

  it('skips rows with non-numeric Y when plotting raw points', () => {
    const rows: CellValue[][] = [
      ['2024-01-01', 5],
      ['2024-01-02', null],
      ['2024-01-03', 'n/a'],
      ['2024-01-04', '12.5'],
    ];
    const series = run(SALES, rows, { type: 'line', xColumn: 0, yColumn: 1, agg: 'none' });
    expect(series.kind).toBe('points');
    if (series.kind !== 'points') return;
    expect(series.points).toEqual([
      { x: '2024-01-01', xNum: null, y: 5 },
      { x: '2024-01-04', xNum: null, y: 12.5 },
    ]);
  });

  it('carries a numeric x position when the X cells parse as numbers', () => {
    const rows: CellValue[][] = [
      [1, 100],
      ['2', 200],
    ];
    const series = run(SALES, rows, { type: 'scatter', xColumn: 0, yColumn: 1, agg: 'none' });
    if (series.kind !== 'points') return;
    expect(series.points).toEqual([
      { x: '1', xNum: 1, y: 100 },
      { x: '2', xNum: 2, y: 200 },
    ]);
  });
});

describe('bucket ordering', () => {
  it('sorts a numeric X ascending by value, not as text', () => {
    const rows: CellValue[][] = [
      [2, 'a'],
      [10, 'b'],
      [1, 'c'],
    ];
    const series = run(SALES, rows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'count' });
    if (series.kind !== 'buckets') return;
    expect(series.buckets.map((b) => b.label)).toEqual(['1', '2', '10']);
  });

  it('sorts a categorical X by row count, ties in first-seen order', () => {
    const rows: CellValue[][] = [
      ['B', 1],
      ['A', 1],
      ['C', 1],
      ['C', 1],
      ['C', 1],
    ];
    const series = run(SALES, rows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'count' });
    if (series.kind !== 'buckets') return;
    expect(series.buckets.map((b) => b.label)).toEqual(['C', 'B', 'A']);
  });

  it('keeps the Other bucket last even though it is the biggest', () => {
    const rows: CellValue[][] = [];
    for (let i = 0; i < 40; i += 1) {
      for (let r = 0; r < 40 - i; r += 1) rows.push([`c${i}`, 1]);
    }
    const series = run(SALES, rows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'count' });
    if (series.kind !== 'buckets') return;
    expect(series.buckets[0].label).toBe('c0');
    expect(series.buckets[series.buckets.length - 1].label).toBe(OTHER_LABEL);
  });
});

describe('bucket cap', () => {
  const rows: CellValue[][] = [];
  for (let i = 0; i < 40; i += 1) {
    // Country i holds i+1 rows; every row contributes 10 to the sum.
    for (let r = 0; r <= i; r += 1) rows.push([`c${i}`, 10]);
  }

  it('keeps the top 30 buckets by frequency and merges the rest into Other', () => {
    const series = run(SALES, rows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'count' });
    if (series.kind !== 'buckets') return;
    expect(rows.length).toBeGreaterThan(MAX_BUCKETS);
    expect(series.buckets.length).toBe(MAX_BUCKETS + 1);
    // Top 30 = c10..c39 (counts 11..40); Other swallows c0..c9 (10..1 rows).
    const other = series.buckets[series.buckets.length - 1];
    expect(other.label).toBe(OTHER_LABEL);
    expect(other.count).toBe(55);
    expect(other.value).toBe(55);
  });

  it('merges exactly for sum and average, too', () => {
    const sum = run(SALES, rows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'sum' });
    if (sum.kind !== 'buckets') return;
    const other = sum.buckets[sum.buckets.length - 1];
    expect(other.value).toBe(550);

    // Every merged row carries 10, so the merged average must stay exact.
    const avg = run(SALES, rows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'avg' });
    if (avg.kind !== 'buckets') return;
    expect(avg.buckets[avg.buckets.length - 1].value).toBe(10);
  });

  it('never rewrites a raw point series', () => {
    const series = run(SALES, rows, { type: 'scatter', xColumn: 0, yColumn: 1, agg: 'none' });
    if (series.kind !== 'points') return;
    expect(series.points.length).toBe(rows.length);
  });

  it('leaves a numeric X sorted ascending with Other pinned last', () => {
    const numericRows: CellValue[][] = [];
    for (let i = 0; i < 35; i += 1) numericRows.push([i, 1]);
    const series = run(SALES, numericRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'count' });
    if (series.kind !== 'buckets') return;
    expect(series.buckets.length).toBe(MAX_BUCKETS + 1);
    // Every bucket holds one row, so the cap keeps the first 30 seen and the
    // tail (30..34) merges into Other; the kept ones sort numerically.
    expect(series.buckets[0].label).toBe('0');
    expect(series.buckets[MAX_BUCKETS - 1].label).toBe('29');
    expect(series.buckets[MAX_BUCKETS].label).toBe(OTHER_LABEL);
  });
});

describe('bar and pie always aggregate', () => {
  it('treats agg none on bar as count', () => {
    const series = run(SALES, salesRows, { type: 'bar', xColumn: 0, yColumn: 1, agg: 'none' });
    if (series.kind !== 'buckets') return;
    expect(series.agg).toBe('count');
    expect(Object.fromEntries(series.buckets.map((b) => [b.label, b.value]))).toEqual({
      Germany: 3,
      Mexico: 2,
    });
  });

  it('treats agg none on pie as count', () => {
    const series = run(SALES, salesRows, { type: 'pie', xColumn: 0, yColumn: 1, agg: 'none' });
    if (series.kind !== 'buckets') return;
    expect(series.agg).toBe('count');
  });

  it('keeps raw points for line and scatter', () => {
    for (const type of ['line', 'scatter'] as const) {
      const series = run(SALES, salesRows, { type, xColumn: 0, yColumn: 1, agg: 'none' });
      expect(series.kind).toBe('points');
    }
  });
});

describe('default chart config', () => {
  it('picks the first string-ish column for X and the first numeric column for Y', () => {
    const columns = [column('CustomerID', 'INT'), column('Name'), column('Amount', 'DECIMAL')];
    const config = defaultChartConfig(chart(columns, [[7, 'Acme', 42]]));
    expect(config).toEqual({ type: 'bar', xColumn: 1, yColumn: 0, agg: 'sum' });
  });

  it('counts rows when no column is numeric-like', () => {
    const columns = [column('Name'), column('Country')];
    const config = defaultChartConfig(chart(columns, [['Acme', 'Germany']]));
    expect(config).toEqual({ type: 'bar', xColumn: 0, yColumn: 0, agg: 'count' });
  });

  it('reads a VARCHAR of numbers as numeric-like', () => {
    const columns = [column('Zip'), column('Name')];
    const config = defaultChartConfig(
      chart(columns, [
        ['10001', 'Acme'],
        ['10002', 'Borealis'],
      ]),
    );
    // Zip parses as numbers, so X falls through to the first string column.
    expect(config).toEqual({ type: 'bar', xColumn: 1, yColumn: 0, agg: 'sum' });
  });

  it('never sums X against itself when every column is numeric', () => {
    const columns = [column('A', 'INT'), column('B', 'INT')];
    const config = defaultChartConfig(chart(columns, [[1, 2]]));
    expect(config).toEqual({ type: 'bar', xColumn: 0, yColumn: 1, agg: 'sum' });
  });

  it('degrades to a harmless config for a result with no columns', () => {
    expect(defaultChartConfig(chart([], []))).toEqual({
      type: 'bar',
      xColumn: 0,
      yColumn: 0,
      agg: 'count',
    });
  });
});

describe('degenerate inputs', () => {
  it('returns an empty series for out-of-range column indexes', () => {
    const series = run(SALES, salesRows, { type: 'bar', xColumn: 9, yColumn: 1, agg: 'sum' });
    expect(series.kind).toBe('buckets');
    if (series.kind !== 'buckets') return;
    expect(series.buckets).toEqual([]);
  });

  it('returns an empty series for an empty row set', () => {
    const series = run(SALES, [], { type: 'bar', xColumn: 0, yColumn: 1, agg: 'sum' });
    if (series.kind !== 'buckets') return;
    expect(series.buckets).toEqual([]);
  });
});
