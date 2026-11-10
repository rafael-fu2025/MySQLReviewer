import { useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import { BarChart3, Download } from 'lucide-react';
import type { CellValue, QueryColumn } from '@shared/types';
import { downloadText } from '@/lib/api';
import { formatNumber, isNumericLike } from '@/lib/format';
import { prepareChartData, type ChartConfig, type ChartSeries } from '@/lib/chart-data';
import { Button, EmptyState } from './ui';

/* ------------------------------------------------------------------ */
/* Result chart                                                        */
/* ------------------------------------------------------------------ */

/**
 * Renders a query result as one of four chart types — bar, line, pie or
 * scatter — with hand-rolled SVG only (no chart library).
 *
 * Colors come from the theme tokens through `var(--color-…, fallback)`:
 * inside the app the token wins so dark and light themes both look right;
 * in a downloaded .svg file the var() cannot resolve and the fallback keeps
 * the chart readable.
 *
 * Tooltips are native `<title>` elements on the marks; crowded axis labels
 * thin themselves out. The width is measured from the container so tick
 * text never stretches (static renders fall back to a sane default). The
 * pie legend is HTML beside the donut, so the downloaded .svg carries the
 * donut and its total, not the legend rows.
 */

const CHART_HEIGHT = 280;

const MARGIN = { top: 18, right: 12, bottom: 34, left: 48 };

/** Measured-width fallback; static renders (tests, first paint) use this. */
const DEFAULT_WIDTH = 760;

const AXIS = 'var(--color-muted, #8e8e93)';
const GRID = 'var(--color-line-soft, #1d1d21)';
const BASELINE = 'var(--color-line, #26262a)';
const INK = 'var(--color-ink, #f2f2f3)';
const INK_SOFT = 'var(--color-ink-soft, #c9c9ce)';
const PRIMARY = 'var(--color-info, #60a5fa)';
const LINE_COLOR = 'var(--color-mint, #2dd4a7)';
const DOT_COLOR = 'var(--color-violet, #a78bfa)';

/** Categorical palette for pie/donut slices and their legend swatches. */
const PALETTE = [
  'var(--color-info, #60a5fa)',
  'var(--color-mint, #2dd4a7)',
  'var(--color-warn, #f5b544)',
  'var(--color-violet, #a78bfa)',
  'var(--color-danger, #ff5c6c)',
  'var(--color-ember-2, #c9c9ce)',
];

/* ------------------------------------------------------------------ */
/* Scale helpers                                                       */
/* ------------------------------------------------------------------ */

/** Rounds up to a 1/2/5 multiple of a power of ten, so axes get round tops. */
function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  const norm = value / base;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * base;
}

interface Scale {
  at(value: number): number;
  ticks: number[];
}

/**
 * Linear scale over [min, max] mapped onto the vertical plot area. Four
 * divisions give enough grid lines without a full tick algorithm.
 */
function verticalScale(min: number, max: number): Scale {
  const top = MARGIN.top;
  const bottom = CHART_HEIGHT - MARGIN.bottom;
  const span = max - min || 1;
  return {
    at: (value) => bottom - ((value - min) / span) * (bottom - top),
    ticks: [0, 1, 2, 3, 4].map((k) => min + (span * k) / 4),
  };
}

/** The y domain a set of values needs: zero-based unless negatives appear. */
function valueScale(values: number[]): Scale {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const min = lo < 0 ? -niceCeil(-lo) : 0;
  const max = hi > 0 ? niceCeil(hi) : lo < 0 ? 0 : 1;
  return verticalScale(min, max);
}

function tickLabel(text: string, max = 12): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ------------------------------------------------------------------ */
/* Shared axis pieces                                                  */
/* ------------------------------------------------------------------ */

function yAxisElements(yScale: Scale, plotWidth: number): ReactElement[] {
  const elements: ReactElement[] = [];
  for (const tick of yScale.ticks) {
    const y = yScale.at(tick);
    elements.push(
      <line
        key={`grid-${tick}`}
        x1={MARGIN.left}
        x2={MARGIN.left + plotWidth}
        y1={y}
        y2={y}
        stroke={GRID}
      />,
      <text
        key={`ytick-${tick}`}
        x={MARGIN.left - 6}
        y={y + 3}
        textAnchor="end"
        fontSize={10}
        fill={AXIS}
      >
        {formatNumber(tick)}
      </text>,
    );
  }
  elements.push(
    <line
      key="baseline"
      x1={MARGIN.left}
      x2={MARGIN.left + plotWidth}
      y1={yScale.at(0)}
      y2={yScale.at(0)}
      stroke={BASELINE}
    />,
  );
  return elements;
}

/** Thin crowded categorical tick labels to roughly one per 72px. */
function labelStride(count: number, plotWidth: number): number {
  const maxLabels = Math.max(2, Math.floor(plotWidth / 72));
  return Math.ceil(count / maxLabels);
}

function categoricalXElements(labels: string[], plotWidth: number): ReactElement[] {
  const stride = labelStride(labels.length, plotWidth);
  const band = plotWidth / labels.length;
  const elements: ReactElement[] = [];
  labels.forEach((label, index) => {
    if (index % stride !== 0) return;
    elements.push(
      <text
        key={`xtick-${index}`}
        x={MARGIN.left + (index + 0.5) * band}
        y={CHART_HEIGHT - MARGIN.bottom + 14}
        textAnchor="middle"
        fontSize={10}
        fill={AXIS}
      >
        {tickLabel(label)}
      </text>,
    );
  });
  return elements;
}

/** Numeric x scale for line/scatter when every X cell parses as a number. */
function numericXScale(values: number[], plotWidth: number): Scale {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  let min = -niceCeil(-lo);
  let max = niceCeil(hi);
  if (min >= max) {
    min = lo - 1;
    max = hi + 1;
  }
  return {
    at: (value) => MARGIN.left + ((value - min) / (max - min)) * plotWidth,
    ticks: [0, 1, 2, 3, 4].map((k) => min + ((max - min) * k) / 4),
  };
}

function numericXElements(scale: Scale): ReactElement[] {
  return scale.ticks.map((tick) => (
    <text
      key={`xtick-${tick}`}
      x={scale.at(tick)}
      y={CHART_HEIGHT - MARGIN.bottom + 14}
      textAnchor="middle"
      fontSize={10}
      fill={AXIS}
    >
      {formatNumber(tick)}
    </text>
  ));
}

/* ------------------------------------------------------------------ */
/* Chart bodies                                                        */
/* ------------------------------------------------------------------ */

interface PlotData {
  labels: string[];
  values: number[];
  /** Numeric x positions when every x reads as a number, else null. */
  numericX: number[] | null;
  tooltip(index: number): string;
}

function plotDataOf(series: ChartSeries): PlotData {
  if (series.kind === 'buckets') {
    return {
      labels: series.buckets.map((bucket) => bucket.label),
      values: series.buckets.map((bucket) => bucket.value),
      numericX:
        series.buckets.length > 0 && series.buckets.every((bucket) => isNumericLike(bucket.label))
          ? series.buckets.map((bucket) => Number(bucket.label))
          : null,
      tooltip: (index) =>
        `${series.buckets[index].label} — ${formatNumber(series.buckets[index].value)} (${series.buckets[index].count} rows)`,
    };
  }
  return {
    labels: series.points.map((point) => point.x),
    values: series.points.map((point) => point.y),
    numericX:
      series.points.length > 0 && series.points.every((point) => point.xNum != null)
        ? series.points.map((point) => point.xNum as number)
        : null,
    tooltip: (index) => `${series.points[index].x} — ${formatNumber(series.points[index].y)}`,
  };
}

/** x/y positions of the marks; numeric X scales by value, else band centers. */
function markPositions(
  data: PlotData,
  plotWidth: number,
): { positions: { x: number; y: number }[]; yScale: Scale } {
  const yScale = valueScale(data.values);
  const numericX = data.numericX;
  if (numericX) {
    const xScale = numericXScale(numericX, plotWidth);
    return {
      positions: data.values.map((value, index) => ({
        x: xScale.at(numericX[index]),
        y: yScale.at(value),
      })),
      yScale,
    };
  }
  return {
    positions: data.values.map((value, index) => ({
      x: MARGIN.left + ((index + 0.5) * plotWidth) / data.values.length,
      y: yScale.at(value),
    })),
    yScale,
  };
}

function BarChartBody({
  data,
  plotWidth,
  svgRef,
}: {
  data: PlotData;
  plotWidth: number;
  svgRef: RefObject<SVGSVGElement | null>;
}): ReactElement {
  const yScale = valueScale(data.values);
  const band = plotWidth / data.values.length;
  const barWidth = Math.min(band * 0.65, 48);
  const showValues = data.values.length <= 20;
  const elements: ReactElement[] = [];
  data.values.forEach((value, index) => {
    const center = MARGIN.left + (index + 0.5) * band;
    const top = Math.min(yScale.at(value), yScale.at(0));
    const bottom = Math.max(yScale.at(value), yScale.at(0));
    if (bottom - top > 0.5) {
      elements.push(
        <rect
          key={`bar-${index}`}
          x={center - barWidth / 2}
          y={top}
          width={barWidth}
          height={bottom - top}
          rx={2}
          fill={PRIMARY}
        >
          <title>{data.tooltip(index)}</title>
        </rect>,
      );
    }
    if (showValues && value !== 0) {
      const labelY = value < 0 ? Math.min(bottom + 12, CHART_HEIGHT - 6) : Math.max(top - 4, 10);
      elements.push(
        <text
          key={`value-${index}`}
          x={center}
          y={labelY}
          textAnchor="middle"
          fontSize={9.5}
          fill={INK_SOFT}
        >
          {formatNumber(value)}
        </text>,
      );
    }
  });
  return (
    <svg ref={svgRef} width="100%" height={CHART_HEIGHT} role="img" aria-label="Bar chart">
      {yAxisElements(yScale, plotWidth)}
      {elements}
      {categoricalXElements(data.labels, plotWidth)}
    </svg>
  );
}

function LineChartBody({
  data,
  plotWidth,
  svgRef,
}: {
  data: PlotData;
  plotWidth: number;
  svgRef: RefObject<SVGSVGElement | null>;
}): ReactElement {
  const { positions, yScale } = markPositions(data, plotWidth);
  const numericX = data.numericX;
  return (
    <svg ref={svgRef} width="100%" height={CHART_HEIGHT} role="img" aria-label="Line chart">
      {yAxisElements(yScale, plotWidth)}
      {positions.length >= 2 ? (
        <polyline
          points={positions.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
          fill="none"
          stroke={LINE_COLOR}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
      {positions.map((position, index) => (
        <circle key={`dot-${index}`} cx={position.x} cy={position.y} r={2.5} fill={LINE_COLOR}>
          <title>{data.tooltip(index)}</title>
        </circle>
      ))}
      {numericX
        ? numericXElements(numericXScale(numericX, plotWidth))
        : categoricalXElements(data.labels, plotWidth)}
    </svg>
  );
}

function ScatterChartBody({
  data,
  plotWidth,
  svgRef,
}: {
  data: PlotData;
  plotWidth: number;
  svgRef: RefObject<SVGSVGElement | null>;
}): ReactElement {
  const { positions, yScale } = markPositions(data, plotWidth);
  const numericX = data.numericX;
  return (
    <svg ref={svgRef} width="100%" height={CHART_HEIGHT} role="img" aria-label="Scatter chart">
      {yAxisElements(yScale, plotWidth)}
      {positions.map((position, index) => (
        <circle
          key={`dot-${index}`}
          cx={position.x}
          cy={position.y}
          r={3}
          fill={DOT_COLOR}
          fillOpacity={0.85}
        >
          <title>{data.tooltip(index)}</title>
        </circle>
      ))}
      {numericX
        ? numericXElements(numericXScale(numericX, plotWidth))
        : categoricalXElements(data.labels, plotWidth)}
    </svg>
  );
}

/** One donut arc path between two angles (radians, clockwise). */
function donutSlice(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  start: number,
  end: number,
): string {
  const large = end - start > Math.PI ? 1 : 0;
  const point = (radius: number, angle: number): [number, number] => [
    cx + radius * Math.cos(angle),
    cy + radius * Math.sin(angle),
  ];
  const [x1, y1] = point(rOuter, start);
  const [x2, y2] = point(rOuter, end);
  const [x3, y3] = point(rInner, end);
  const [x4, y4] = point(rInner, start);
  return [
    `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
    'Z',
  ].join(' ');
}

const PIE_SIZE = 248;

function PieChartBody({
  data,
  svgRef,
}: {
  data: PlotData;
  svgRef: RefObject<SVGSVGElement | null>;
}): ReactElement {
  // Pie angles need non-negative slices: negatives clamp to zero, and a
  // zero total is rejected by the parent before this renders.
  const clamped = data.values.map((value) => Math.max(0, value));
  const total = clamped.reduce((sum, value) => sum + value, 0);
  const single = clamped.length === 1;
  // Cumulative slice ends measured from the 12 o'clock start, built with
  // reduce so nothing render-scope gets reassigned along the way.
  const ends = clamped.reduce<number[]>((acc, value) => {
    const previous = acc.length === 0 ? -Math.PI / 2 : acc[acc.length - 1];
    acc.push(previous + (total > 0 ? (value / total) * Math.PI * 2 : 0));
    return acc;
  }, []);
  const slices = clamped.map((value, index) => {
    const start = index === 0 ? -Math.PI / 2 : ends[index - 1];
    const end = ends[index];
    return {
      color: PALETTE[index % PALETTE.length],
      path: single ? null : donutSlice(PIE_SIZE / 2, PIE_SIZE / 2, 104, 66, start, end),
      label: data.labels[index],
      value: data.values[index],
      percent: total > 0 ? (value / total) * 100 : 0,
    };
  });
  return (
    <div className="flex min-h-0 flex-1 items-start gap-4">
      <svg width={PIE_SIZE} height={PIE_SIZE} role="img" aria-label="Pie chart" ref={svgRef}>
        {slices.map((slice, index) =>
          slice.path ? (
            <path key={`slice-${index}`} d={slice.path} fill={slice.color}>
              <title>{`${slice.label} — ${formatNumber(slice.value)} (${slice.percent.toFixed(1)}%)`}</title>
            </path>
          ) : (
            <circle
              key={`slice-${index}`}
              cx={PIE_SIZE / 2}
              cy={PIE_SIZE / 2}
              r={85}
              fill="none"
              stroke={slice.color}
              strokeWidth={38}
            >
              <title>{`${slice.label} — ${formatNumber(slice.value)}`}</title>
            </circle>
          ),
        )}
        <text
          x={PIE_SIZE / 2}
          y={PIE_SIZE / 2 + 4}
          textAnchor="middle"
          fontSize={13}
          fontWeight={650}
          fill={INK}
        >
          {formatNumber(total)}
        </text>
      </svg>
      <div className="max-h-[280px] min-w-44 flex-1 overflow-y-auto pr-1">
        {slices.map((slice, index) => (
          <div key={`legend-${index}`} className="flex items-center gap-2 py-0.5 text-2xs">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: slice.color }}
              aria-hidden="true"
            />
            <span className="truncate text-ink-soft" title={slice.label}>
              {slice.label}
            </span>
            <span className="ml-auto shrink-0 font-mono text-muted">
              {formatNumber(slice.value)} · {slice.percent.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

function seriesCaption(series: ChartSeries): string {
  if (series.kind === 'points') return `${series.yLabel} by ${series.xLabel}`;
  if (series.agg === 'count') return `count of rows by ${series.xLabel}`;
  const label = series.agg === 'avg' ? 'average' : series.agg;
  return `${label} of ${series.yLabel} by ${series.xLabel}`;
}

export function ResultChart({
  columns,
  rows,
  config,
}: {
  columns: QueryColumn[];
  rows: CellValue[][];
  config: ChartConfig;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  const series = useMemo(
    () => prepareChartData({ columns, rows }, config),
    [columns, rows, config],
  );

  // Responsive width: the SVG viewBox is re-set to the measured container
  // width, so tick text never stretches. Static renders keep the fallback.
  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(Math.max(320, Math.round(next)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <EmptyState
          icon={<BarChart3 size={22} />}
          title="Nothing to chart"
          copy="Run a statement that returns rows, then chart the result here."
        />
      </div>
    );
  }

  const empty =
    series.kind === 'buckets' ? series.buckets.length === 0 : series.points.length === 0;
  if (empty) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <EmptyState
          icon={<BarChart3 size={22} />}
          title="No numeric values to plot"
          copy={`No row has a numeric value in the ${series.yLabel} column — masked and non-numeric cells are excluded. Try aggregation Count instead.`}
        />
      </div>
    );
  }

  if (config.type === 'pie') {
    const data = plotDataOf(series);
    const total = data.values.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (total <= 0) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <EmptyState
            icon={<BarChart3 size={22} />}
            title="No positive values to chart"
            copy="Every bucket is zero or negative, so a pie has nothing to slice. Switch to Bar instead."
          />
        </div>
      );
    }
  }

  const caption = seriesCaption(series);
  const plotWidth = Math.max(10, width - MARGIN.left - MARGIN.right);
  const data = plotDataOf(series);

  const downloadSvg = (): void => {
    const node = svgRef.current;
    if (!node) return;
    const clone = node.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const markup = new XMLSerializer().serializeToString(clone);
    downloadText('mylens-chart.svg', markup, 'image/svg+xml;charset=utf-8');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate font-mono text-2xs text-muted" title={caption}>
          {caption}
        </span>
        <Button variant="tertiary" size="sm" icon={<Download size={12} />} onClick={downloadSvg}>
          Download SVG
        </Button>
      </div>
      <div ref={wrapRef} className="min-h-0 flex-1 px-3 pb-3">
        {config.type === 'bar' ? (
          <BarChartBody data={data} plotWidth={plotWidth} svgRef={svgRef} />
        ) : config.type === 'line' ? (
          <LineChartBody data={data} plotWidth={plotWidth} svgRef={svgRef} />
        ) : config.type === 'scatter' ? (
          <ScatterChartBody data={data} plotWidth={plotWidth} svgRef={svgRef} />
        ) : (
          <PieChartBody data={data} svgRef={svgRef} />
        )}
      </div>
    </div>
  );
}
