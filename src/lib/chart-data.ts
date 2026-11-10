import type { CellValue, QueryColumn } from '@shared/types';
import { cellText, isNumericLike } from './format';

/* ------------------------------------------------------------------ */
/* Chart data preparation                                              */
/* ------------------------------------------------------------------ */

/**
 * Turns a query result into the series a `ResultChart` renders.
 *
 * Everything here is pure and DOM-free so the bucketing math is tested
 * directly. The displayed value of a cell is always `cellText` from
 * `format.ts` — the same text the grid prints — so a bucket, a tick label
 * and the table can never disagree about what a cell says.
 */

export type ChartType = 'bar' | 'line' | 'pie' | 'scatter';

export type ChartAggregation = 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface ChartConfig {
  type: ChartType;
  /** Index into `columns` of the bucket / category axis. */
  xColumn: number;
  /** Index into `columns` of the measured value. */
  yColumn: number;
  agg: ChartAggregation;
}

/** One aggregated bucket: `value` is the aggregate, `count` the rows in it. */
export interface ChartBucket {
  label: string;
  value: number;
  count: number;
}

/** One raw point (`agg: 'none'`): `x` is the displayed cell text. */
export interface ChartPoint {
  x: string;
  /** Numeric value of the X cell, or null when X is categorical. */
  xNum: number | null;
  y: number;
}

export type ChartSeries =
  | {
      kind: 'buckets';
      agg: ChartAggregation;
      xLabel: string;
      yLabel: string;
      buckets: ChartBucket[];
    }
  | { kind: 'points'; xLabel: string; yLabel: string; points: ChartPoint[] };

/** Just the pieces of a `QueryResult` the preparation reads. */
export interface ChartSource {
  columns: QueryColumn[];
  rows: CellValue[][];
}

/**
 * Bar and pie keep at most this many buckets; anything past it merges into
 * the `Other` bucket (last), because forty slices or forty bars cannot be
 * read anyway.
 */
export const MAX_BUCKETS = 30;

/** Label of the bucket that swallows everything past `MAX_BUCKETS`. */
export const OTHER_LABEL = 'Other';

export const CHART_TYPE_OPTIONS: { value: ChartType; label: string }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'pie', label: 'Pie' },
  { value: 'scatter', label: 'Scatter' },
];

export const AGGREGATION_OPTIONS: { value: ChartAggregation; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
];

/**
 * Whether a column reads as numeric: its MySQL type says so, or at least
 * half of the first hundred non-null cells parse as numbers (a VARCHAR full
 * of `"42"` is a measure just as much as an INT). Masked cells (`••••`) and
 * prose never count as numeric.
 */
function isNumericishColumn(column: QueryColumn, rows: CellValue[][], index: number): boolean {
  if (
    /\b(tinyint|smallint|mediumint|bigint|int|integer|decimal|numeric|float|double|real|bit|bool|boolean|year)\b/i.test(
      column.typeName,
    )
  ) {
    return true;
  }
  let numeric = 0;
  let sampled = 0;
  for (const row of rows) {
    const value = row[index];
    if (value == null) continue;
    sampled += 1;
    if (isNumericLike(value)) numeric += 1;
    if (sampled >= 100) break;
  }
  return sampled > 0 && numeric / sampled >= 0.5;
}

/**
 * Sensible starting point for a result: the first string-ish column on X,
 * the first numeric-like column on Y, aggregation `sum` — or `count` when
 * no column is numeric-like (Y then mirrors X, where `count` ignores it).
 * When every column is numeric, Y becomes the second column so the chart
 * relates two measures instead of summing X against itself.
 */
export function defaultChartConfig(source: ChartSource): ChartConfig {
  const { columns, rows } = source;
  let xColumn = 0;
  for (let index = 0; index < columns.length; index += 1) {
    if (!isNumericishColumn(columns[index], rows, index)) {
      xColumn = index;
      break;
    }
  }
  let yColumn = -1;
  for (let index = 0; index < columns.length; index += 1) {
    if (isNumericishColumn(columns[index], rows, index)) {
      yColumn = index;
      break;
    }
  }
  if (yColumn < 0) {
    // No numeric column anywhere: count rows per X bucket instead.
    return { type: 'bar', xColumn, yColumn: xColumn, agg: 'count' };
  }
  if (yColumn === xColumn && columns.length > 1) {
    const second = columns.findIndex((_, index) => index !== xColumn);
    if (second >= 0) yColumn = second;
  }
  return { type: 'bar', xColumn, yColumn, agg: 'sum' };
}

/* ------------------------------------------------------------------ */
/* Bucketing                                                           */
/* ------------------------------------------------------------------ */

/**
 * Running totals for one bucket. Keeping `sum` and `numericCount` apart (not
 * a running average) means `avg` stays exact even after the Other merge
 * combines buckets.
 */
interface BucketAcc {
  key: string;
  count: number;
  numericCount: number;
  sum: number;
  min: number;
  max: number;
}

function resolveBucketValue(acc: BucketAcc, agg: ChartAggregation): number | null {
  switch (agg) {
    case 'count':
      return acc.count;
    case 'sum':
      return acc.numericCount > 0 ? acc.sum : null;
    case 'avg':
      return acc.numericCount > 0 ? acc.sum / acc.numericCount : null;
    case 'min':
      return acc.numericCount > 0 ? acc.min : null;
    case 'max':
      return acc.numericCount > 0 ? acc.max : null;
    default:
      return null;
  }
}

/**
 * Sorting policy for bucketed series, applied after the cap:
 *
 * 1. Numeric-like labels sort ascending by numeric value (a numeric X axis
 *    reads left-to-right).
 * 2. Remaining labels sort by row count descending, ties in first-seen
 *    order, so bar/pie lead with the biggest groups.
 * 3. The `Other` bucket always goes last — it is a merged tail, and letting
 *    it jump to the front would hide the shape of the top buckets.
 */
function sortBuckets(buckets: ChartBucket[]): ChartBucket[] {
  const sorted = [...buckets].sort((a, b) => {
    if (a.label === OTHER_LABEL) return 1;
    if (b.label === OTHER_LABEL) return -1;
    const aNumeric = isNumericLike(a.label);
    const bNumeric = isNumericLike(b.label);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (aNumeric && bNumeric) return Number(a.label) - Number(b.label);
    return b.count - a.count;
  });
  return sorted;
}

/**
 * Prepares the series for one chart configuration.
 *
 * - Bar and pie always bucket their rows; an `agg: 'none'` config on them
 *   acts as `count` (a bar chart of raw rows is a histogram of X values).
 * - Line and scatter plot one point per row with `agg: 'none'`; rows whose
 *   Y cell is not numeric-like (masked, NULL, prose) are skipped. With any
 *   other aggregation they render buckets, exactly like bar.
 * - For `sum`/`avg`/`min`/`max`, only numeric-like Y cells contribute;
 *   buckets with no numeric Y value at all are left out.
 * - The bucket cap (`MAX_BUCKETS`) applies to aggregated series only — raw
 *   point series are never rewritten.
 */
export function prepareChartData(source: ChartSource, config: ChartConfig): ChartSeries {
  const { columns, rows } = source;
  // Bar/pie always aggregate; line/scatter plot raw points only without one.
  const bucketed = config.agg !== 'none' || config.type === 'bar' || config.type === 'pie';
  const agg: ChartAggregation = bucketed && config.agg === 'none' ? 'count' : config.agg;
  const xLabel = columns[config.xColumn]?.name ?? 'X';
  const yLabel = agg === 'count' ? 'Count' : (columns[config.yColumn]?.name ?? 'Y');

  const xValid = config.xColumn >= 0 && config.xColumn < columns.length;
  const yValid = config.yColumn >= 0 && config.yColumn < columns.length;
  if (!xValid || columns.length === 0 || rows.length === 0) {
    return { kind: 'buckets', agg, xLabel, yLabel, buckets: [] };
  }

  if (!bucketed) {
    const points: ChartPoint[] = [];
    for (const row of rows) {
      const yValue = row[yValid ? config.yColumn : config.xColumn];
      if (!isNumericLike(yValue)) continue;
      const xValue = row[config.xColumn];
      points.push({
        x: cellText(xValue),
        xNum: isNumericLike(xValue) ? Number(xValue) : null,
        y: Number(yValue),
      });
    }
    return { kind: 'points', xLabel, yLabel, points };
  }

  const accs = new Map<string, BucketAcc>();
  for (const row of rows) {
    const key = cellText(row[config.xColumn]);
    let acc = accs.get(key);
    if (!acc) {
      acc = { key, count: 0, numericCount: 0, sum: 0, min: Infinity, max: -Infinity };
      accs.set(key, acc);
    }
    acc.count += 1;
    if (agg !== 'count' && yValid) {
      const value = row[config.yColumn];
      if (isNumericLike(value)) {
        const num = Number(value);
        acc.numericCount += 1;
        acc.sum += num;
        acc.min = Math.min(acc.min, num);
        acc.max = Math.max(acc.max, num);
      }
    }
  }

  // Cap: keep the top buckets by row count, merge the tail into `Other`.
  // Merging happens on the accumulators, so `avg`/`min`/`max` of `Other`
  // stay exact rather than being re-derived from already-aggregated values.
  let list = [...accs.values()];
  if (list.length > MAX_BUCKETS) {
    list.sort((a, b) => b.count - a.count);
    const kept = list.slice(0, MAX_BUCKETS);
    const tail = list.slice(MAX_BUCKETS);
    const merged: BucketAcc = {
      key: OTHER_LABEL,
      count: tail.reduce((sum, acc) => sum + acc.count, 0),
      numericCount: tail.reduce((sum, acc) => sum + acc.numericCount, 0),
      sum: tail.reduce((sum, acc) => sum + acc.sum, 0),
      min: Math.min(...tail.map((acc) => acc.min)),
      max: Math.max(...tail.map((acc) => acc.max)),
    };
    list = [...kept, merged];
  }

  const buckets: ChartBucket[] = [];
  for (const acc of list) {
    const value = resolveBucketValue(acc, agg);
    if (value == null || !Number.isFinite(value)) continue;
    buckets.push({ label: acc.key, value, count: acc.count });
  }
  return { kind: 'buckets', agg, xLabel, yLabel, buckets: sortBuckets(buckets) };
}
