import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ban,
  ChevronDown,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Lock,
  Rows3,
  X,
} from 'lucide-react';
import type { CellValue, QueryColumn, QueryResult } from '@shared/types';
import {
  cellText,
  copyText,
  downloadCsv,
  downloadJson,
  filterRows,
  formatDuration,
  formatNumber,
  sortRows,
  sqlInsertTarget,
  toMarkdownTable,
  toSqlInsert,
  toTsv,
} from '@/lib/format';
import {
  AGGREGATION_OPTIONS,
  CHART_TYPE_OPTIONS,
  defaultChartConfig,
  type ChartAggregation,
  type ChartConfig,
  type ChartType,
} from '@/lib/chart-data';
import { useAppStore } from '@/store/app-store';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  IconButton,
  Modal,
  SearchInput,
  Segmented,
  Skeleton,
} from './ui';
import { ResultChart } from './ResultChart';

function cellContent(value: CellValue): { node: ReactNode; className: string; title?: string } {
  if (value === null) {
    return {
      node: <span className="italic text-muted/70">NULL</span>,
      className: 'null',
    };
  }
  if (typeof value === 'number') {
    return { node: value, className: 'num' };
  }
  if (typeof value === 'boolean') {
    return { node: String(value), className: 'text-warn' };
  }
  if (Array.isArray(value)) {
    const text = JSON.stringify(value);
    return {
      node: text.length > 160 ? `${text.slice(0, 160)}…` : text,
      className: 'text-violet',
      title: text.slice(0, 2_000),
    };
  }
  if (typeof value === 'object') {
    if ('__type' in value && (value as { __type?: string }).__type === 'binary') {
      const binary = value as {
        length: number;
        previewHex: string;
        truncated: boolean;
      };
      return {
        node: `0x${binary.previewHex}${binary.truncated ? '…' : ''}`,
        className: 'bin',
        title: `${binary.length} bytes`,
      };
    }
    const text = JSON.stringify(value);
    return {
      node: text.length > 160 ? `${text.slice(0, 160)}…` : text,
      className: 'text-violet',
      title: text.slice(0, 2_000),
    };
  }
  const text = String(value);
  return {
    node: text.length > 180 ? `${text.slice(0, 180)}…` : text,
    className: '',
    title: text.length > 180 ? text.slice(0, 2_000) : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Column sort                                                         */
/* ------------------------------------------------------------------ */

type SortDir = 'asc' | 'desc';

interface SortState {
  column: number;
  dir: SortDir;
}

/** Clicking a header cycles asc → desc → off. */
function nextSort(current: SortState | null, column: number): SortState | null {
  if (!current || current.column !== column) return { column, dir: 'asc' };
  if (current.dir === 'asc') return { column, dir: 'desc' };
  return null;
}

/* ------------------------------------------------------------------ */
/* Copy-as formats                                                     */
/* ------------------------------------------------------------------ */

const COPY_FORMATS = [
  { key: 'json', label: 'Copy JSON' },
  { key: 'tsv', label: 'Copy TSV' },
  { key: 'markdown', label: 'Copy Markdown' },
  { key: 'sql', label: 'Copy SQL INSERT' },
] as const;

type CopyFormat = (typeof COPY_FORMATS)[number]['key'];

/* ------------------------------------------------------------------ */
/* Quick filter                                                        */
/* ------------------------------------------------------------------ */

/** How long the filter input waits for the user to stop typing. */
const FILTER_DEBOUNCE_MS = 150;

/**
 * The "N of M rows match" readout next to the filter input. Rendered only
 * while a filter is active.
 */
export function FilterReadout({
  filter,
  matched,
  total,
}: {
  filter: string;
  matched: number;
  total: number;
}) {
  if (!filter) return null;
  return (
    <span className="font-mono text-2xs text-muted">
      {formatNumber(matched)} of {formatNumber(total)} rows match
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Chart view                                                          */
/* ------------------------------------------------------------------ */

/**
 * The four chart knobs, shown only while the chart view is open. Bar and
 * pie always bucket their rows, so `None` is not offered for them; switching
 * to one of those while `None` is selected falls back to `Count`.
 */
export function ChartConfigRow({
  columns,
  config,
  onChange,
}: {
  columns: QueryColumn[];
  config: ChartConfig;
  onChange: (patch: Partial<ChartConfig>) => void;
}) {
  const forBarPie = config.type === 'bar' || config.type === 'pie';
  const aggOptions = AGGREGATION_OPTIONS.filter((option) => !forBarPie || option.value !== 'none');
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-2xs text-muted">
      <label className="flex items-center gap-1.5">
        Type
        <select
          className="select w-auto py-1 text-2xs"
          aria-label="Chart type"
          value={config.type}
          onChange={(event) => {
            const type = event.target.value as ChartType;
            if ((type === 'bar' || type === 'pie') && config.agg === 'none') {
              onChange({ type, agg: 'count' });
            } else {
              onChange({ type });
            }
          }}
        >
          {CHART_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        X column
        <select
          className="select w-auto py-1 text-2xs"
          aria-label="Chart X column"
          value={config.xColumn}
          onChange={(event) => onChange({ xColumn: Number(event.target.value) })}
        >
          {columns.map((column, index) => (
            <option key={`${column.name}-${index}`} value={index}>
              {column.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        Y column
        <select
          className="select w-auto py-1 text-2xs"
          aria-label="Chart Y column"
          value={config.yColumn}
          disabled={config.agg === 'count'}
          onChange={(event) => onChange({ yColumn: Number(event.target.value) })}
        >
          {columns.map((column, index) => (
            <option key={`${column.name}-${index}`} value={index}>
              {column.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        Aggregation
        <select
          className="select w-auto py-1 text-2xs"
          aria-label="Chart aggregation"
          value={config.agg}
          onChange={(event) => onChange({ agg: event.target.value as ChartAggregation })}
        >
          {aggOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cell inspector                                                      */
/* ------------------------------------------------------------------ */

/**
 * One node of the inspector's JSON tree. Objects and arrays collapse through
 * the native `<details>` element; leaves print their JSON form, with strings
 * quoted so `"5"` and `5` never look the same.
 */
function JsonNode({ name, value }: { name?: string; value: unknown }) {
  if (value !== null && typeof value === 'object') {
    const entries: [string, unknown][] = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value as Record<string, unknown>);
    return (
      <details open>
        <summary className="cursor-pointer select-none py-0.5">
          {name !== undefined ? <span className="text-info">{name} </span> : null}
          <span className="text-muted">
            {Array.isArray(value)
              ? `[···] ${entries.length} items`
              : `{···} ${entries.length} fields`}
          </span>
        </summary>
        <div className="ml-3 border-l border-line-soft pl-3">
          {entries.map(([key, item]) => (
            <JsonNode key={key} name={key} value={item} />
          ))}
        </div>
      </details>
    );
  }
  const text =
    value === null ? 'null' : typeof value === 'string' ? JSON.stringify(value) : String(value);
  return (
    <div className="whitespace-pre-wrap break-words py-0.5">
      {name !== undefined ? <span className="text-info">{name}: </span> : null}
      <span className={value === null ? 'italic text-muted/70' : 'text-ink-soft'}>{text}</span>
    </div>
  );
}

/**
 * The full value behind a clicked cell. The browser only ever holds what the
 * grid shows — masked values stay masked and binary cells carry just a hex
 * preview — so the inspector shows exactly that, at full length.
 */
function CellInspectorBody({ value }: { value: CellValue }) {
  if (value === null) {
    return (
      <EmptyState
        icon={<Ban size={20} />}
        title="NULL"
        copy="The cell holds SQL NULL — there is no value to inspect."
      />
    );
  }
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '__type' in value &&
    value.__type === 'binary'
  ) {
    const binary = value as { length: number; previewHex: string; truncated: boolean };
    const hex = binary.previewHex.replace(/(..)/g, '$1 ').trim();
    return (
      <div className="space-y-2">
        <div className="font-mono text-2xs text-muted">
          {formatNumber(binary.length)} bytes
          {binary.truncated ? ' · showing the first bytes only' : ''}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line-soft bg-panel-2 p-3 font-mono text-xs text-violet">
          {hex || '(empty)'}
        </pre>
      </div>
    );
  }
  if (typeof value === 'object' || Array.isArray(value)) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-line-soft p-3 font-mono text-xs">
          <JsonNode value={value} />
        </div>
        <details>
          <summary className="cursor-pointer select-none text-2xs text-muted">Raw JSON</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line-soft bg-panel-2 p-3 font-mono text-xs text-ink-soft">
            {JSON.stringify(value, null, 2)}
          </pre>
        </details>
      </div>
    );
  }
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line-soft bg-panel-2 p-3 font-mono text-xs text-ink-soft">
      {String(value)}
    </pre>
  );
}

/**
 * One result row. Rows are memoized so a parent render (page change, toast,
 * unrelated state) never re-serializes the cells that are already on screen.
 */
const ResultRow = memo(function ResultRow({
  row,
  rowIndex,
  rowNumber,
  onSelectCell,
}: {
  row: CellValue[];
  rowIndex: number;
  rowNumber: number;
  onSelectCell?: (rowIndex: number, columnIndex: number, value: CellValue) => void;
}) {
  return (
    <tr>
      <td className="text-muted/60">{rowNumber}</td>
      {row.map((value, columnIndex) => {
        const cell = cellContent(value);
        return (
          <td
            key={columnIndex}
            className={cn(cell.className, onSelectCell && 'cursor-pointer')}
            title={cell.title}
            onClick={onSelectCell ? () => onSelectCell(rowIndex, columnIndex, value) : undefined}
          >
            {cell.node}
          </td>
        );
      })}
    </tr>
  );
});

/**
 * What a result set was: how many rows came back, and how long the
 * statement took.
 *
 * The grid shows it once, in its own toolbar.
 */
export function ResultsSummary({
  rowCount,
  executionMs,
}: {
  rowCount: number;
  executionMs: number;
}) {
  return (
    <span className="font-mono text-2xs text-muted">
      {formatNumber(rowCount)} rows · {formatDuration(executionMs)}
    </span>
  );
}

/** How many placeholder rows the pending table body shows. */
const PENDING_ROW_COUNT = 5;

/**
 * Placeholder body shown while a re-run refreshes the result. Each cell is a
 * shimmer bar sized to the mono line box (~19px) so a pending row has the
 * same geometry as a data row and the pane does not jump. Widths are
 * deterministic, so server and client markup agree.
 */
function PendingRows({ columnCount }: { columnCount: number }) {
  return (
    <>
      {Array.from({ length: PENDING_ROW_COUNT }, (_, rowIndex) => (
        <tr key={rowIndex} aria-hidden="true">
          <td className="text-muted/60">
            <Skeleton width={18} height={19} />
          </td>
          {Array.from({ length: columnCount }, (_, columnIndex) => (
            <td key={columnIndex}>
              <Skeleton width={`${36 + ((rowIndex * 17 + columnIndex * 41) % 48)}%`} height={19} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * The table of a result set.
 *
 * The rows are the ones on the current page; `rowOffset` is the number of
 * rows that came before them, so the row numbers keep counting.
 *
 * Headers sort asc → desc → off when `onSortClick` is given, cells open the
 * inspector when `onCellClick` is given. Neither is wired in contexts that
 * only render the table (tests, read-only panes).
 *
 * When `pending` is set the body renders placeholder rows instead of data —
 * the grid stays mounted while a re-run is in flight. Sensitive columns are
 * not flagged per-header: the toolbar's masked badge is the single surface
 * for that.
 *
 * The table keeps its natural width and the pane scrolls in both directions:
 * laid out at the width of the pane, the browser squeezed the last column
 * until its values were cut off mid-word, and the pane showed no sign that
 * there was more to see.
 */
export function ResultsTable({
  columns,
  rows,
  rowOffset = 0,
  sort = null,
  pending = false,
  onSortClick,
  onCellClick,
}: {
  columns: QueryColumn[];
  rows: CellValue[][];
  rowOffset?: number;
  sort?: SortState | null;
  pending?: boolean;
  onSortClick?: (columnIndex: number) => void;
  onCellClick?: (rowIndex: number, columnIndex: number, value: CellValue) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
      <table className="data-table min-w-max" aria-busy={pending || undefined}>
        <thead>
          <tr>
            <th style={{ width: 46 }}>#</th>
            {columns.map((column, index) => {
              const active = sort?.column === index;
              return (
                <th
                  key={`${column.name}-${index}`}
                  title={`${column.table ?? ''} ${column.name}`}
                  aria-sort={
                    active && sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  onClick={onSortClick ? () => onSortClick(index) : undefined}
                  className={onSortClick ? 'cursor-pointer select-none' : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {column.name}
                    {active && sort ? (
                      sort.dir === 'asc' ? (
                        <ArrowUp size={9} className="text-info" aria-label="sorted ascending" />
                      ) : (
                        <ArrowDown size={9} className="text-info" aria-label="sorted descending" />
                      )
                    ) : null}
                  </span>
                  <span className="col-type">{column.typeName}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        {/* The body remounts when the placeholder swaps for data (keyed by the
            pending flag), so the mask reveal plays once per re-run when the
            rows arrive — not on every render (sort, filter and paging keep the
            same element). */}
        <tbody key={pending ? 'pending' : 'data'} className={pending ? undefined : 'mask-reveal'}>
          {pending ? (
            <PendingRows columnCount={columns.length} />
          ) : (
            rows.map((row, rowIndex) => (
              <ResultRow
                key={rowOffset + rowIndex}
                row={row}
                rowIndex={rowIndex}
                rowNumber={rowOffset + rowIndex + 1}
                onSelectCell={onCellClick}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The page sizes the footer selector offers. */
const PAGE_SIZES = [50, 100, 250];

/**
 * How long the copy menu stays mounted while its pop-out exit plays. The
 * `.pop-out` utility runs for --duration-exit (120ms), so the unmount timer
 * gets a 10ms beat after the animation is done — the same margin the
 * workspace's format menu uses.
 */
const COPY_MENU_EXIT_MS = 130;

function ResultsGridBase({
  result,
  pending = false,
  onReveal,
}: {
  result: QueryResult;
  /** A re-run over this result: skeleton rows replace the data, the toolbar stays. */
  pending?: boolean;
  onReveal?: () => void;
}) {
  const toast = useAppStore((state) => state.toast);
  const currentUser = useAppStore((state) => state.currentUser);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [revealOpen, setRevealOpen] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);
  const [filterDraft, setFilterDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'table' | 'chart'>('table');
  // Null means "derive the defaults for this result" (see `chartConfig`).
  const [chartConfigDraft, setChartConfigDraft] = useState<ChartConfig | null>(null);
  const [inspected, setInspected] = useState<{
    rowIndex: number;
    columnIndex: number;
    value: CellValue;
  } | null>(null);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [copyMenuWasOpen, setCopyMenuWasOpen] = useState(false);
  const [copyMenuClosing, setCopyMenuClosing] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);

  // A new result always starts on the first page. Adjusting the state while
  // rendering keeps the grid from briefly showing the previous page of the
  // new result and avoids the extra render pass an effect would cause. The
  // sort, the filter, the inspector and the chart configuration belong to
  // the old rows, so they go too.
  const [lastResult, setLastResult] = useState(result);
  if (result !== lastResult) {
    setLastResult(result);
    setPage(0);
    setFilterDraft('');
    setFilter('');
    setSort(null);
    setInspected(null);
    setCopyMenuOpen(false);
    setView('table');
    setChartConfigDraft(null);
  }

  // Adjusting state as the menu toggles keeps it mounted through its exit
  // animation, so it pops back into the Copy button instead of vanishing —
  // the same render-time adjustment the workspace's format menu uses. Close
  // on select also routes through here (`copyAs` just clears the flag), so
  // every dismissal plays the exit.
  if (copyMenuOpen !== copyMenuWasOpen) {
    setCopyMenuWasOpen(copyMenuOpen);
    if (copyMenuOpen) setCopyMenuClosing(false);
    else setCopyMenuClosing(true);
  }

  useEffect(() => {
    if (!copyMenuClosing) return;
    const timer = window.setTimeout(() => setCopyMenuClosing(false), COPY_MENU_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [copyMenuClosing]);

  // The grid is memoized on `result` alone; keep the callback fresh via a ref.
  const onRevealRef = useRef(onReveal);
  useEffect(() => {
    onRevealRef.current = onReveal;
  });

  // The filter applies once typing settles, not on every keystroke: with
  // 10k rows each application scans every cell. A newly applied filter also
  // re-scopes the view: back to the first page, inspector closed.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilter(filterDraft);
      setPage(0);
      setInspected(null);
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filterDraft]);

  const handleSortClick = useCallback((columnIndex: number): void => {
    setSort((current) => nextSort(current, columnIndex));
    setPage(0);
    setInspected(null);
  }, []);

  // A stable callback keeps the memoized rows from re-rendering on every
  // grid-state change; the handler reads the latest closure via a ref.
  const inspectRef = useRef<(rowIndex: number, columnIndex: number, value: CellValue) => void>(
    () => {},
  );
  useEffect(() => {
    inspectRef.current = (rowIndex, columnIndex, value) =>
      setInspected({ rowIndex, columnIndex, value });
  });
  const handleCellClick = useCallback((rowIndex: number, columnIndex: number, value: CellValue) => {
    inspectRef.current(rowIndex, columnIndex, value);
  }, []);

  // The copy menu closes on any click outside of it, and on Escape.
  useEffect(() => {
    if (!copyMenuOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (!copyMenuRef.current?.contains(event.target as Node)) setCopyMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCopyMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [copyMenuOpen]);

  // Filter, then sort, then paginate — each stage sees the full row set the
  // previous stage produced, never just the visible page.
  const filteredRows = useMemo(() => filterRows(result.rows, filter), [result.rows, filter]);
  const sortedRows = useMemo(
    () => (sort ? sortRows(filteredRows, sort.column, sort.dir) : filteredRows),
    [filteredRows, sort],
  );

  // The chart reads the filtered rows (so it agrees with what the table
  // shows) but not the sort — the chart data applies its own ordering.
  const chartConfig = useMemo(
    () => chartConfigDraft ?? defaultChartConfig(result),
    [chartConfigDraft, result],
  );
  const updateChart = (patch: Partial<ChartConfig>): void => {
    setChartConfigDraft({ ...chartConfig, ...patch });
  };

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  // Switching to a smaller page size (or a result that shrank) can leave
  // `page` past the end; clamping keeps the grid on a page that exists
  // without an extra render pass from an effect.
  const currentPage = Math.min(page, totalPages - 1);
  const rows = useMemo(
    () => sortedRows.slice(currentPage * pageSize, currentPage * pageSize + pageSize),
    [currentPage, pageSize, sortedRows],
  );

  const isMutation = result.columns.length === 0;

  const exportCsv = (): void => {
    downloadCsv('mylens-query-result.csv', result.columns, result.rows);
  };
  const exportJson = (): void => {
    downloadJson('mylens-query-result.json', {
      sql: result.sql,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
    });
  };

  // Clipboard copies follow what the grid shows: the current page's rows,
  // after the quick filter and the sort. File exports (CSV/JSON above) still
  // carry the whole result. All four formats share this scope.
  const copyAs = async (format: CopyFormat): Promise<void> => {
    setCopyMenuOpen(false);
    let text: string;
    if (format === 'json') {
      text = JSON.stringify(
        { columns: result.columns.map((column) => column.name), rows },
        null,
        2,
      );
    } else if (format === 'tsv') {
      text = toTsv(result.columns, rows);
    } else if (format === 'markdown') {
      text = toMarkdownTable(result.columns, rows);
    } else {
      text = toSqlInsert(sqlInsertTarget(result.columns), result.columns, rows);
    }
    const ok = await copyText(text);
    toast(
      ok ? 'Result copied to clipboard.' : 'Could not copy the result.',
      ok ? 'success' : 'error',
    );
  };

  /**
   * The Table/Chart toggle crossfades the two views through the View
   * Transitions API: the state update is flushed synchronously inside the
   * transition callback (the React 19 pattern), so the DOM swap happens where
   * the browser snapshots it. The toolbar is identical across both views and
   * carries `view-transition-name: results-toolbar` (misc-pages.css), so it
   * morphs in place while the pane root crossfades. Without the API (older
   * browsers) the swap stays instant.
   */
  const handleViewChange = (next: 'table' | 'chart'): void => {
    if (typeof document.startViewTransition === 'function') {
      document.startViewTransition(() => {
        flushSync(() => setView(next));
      });
      return;
    }
    setView(next);
  };

  const inspectedColumn = inspected ? result.columns[inspected.columnIndex] : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* `results-toolbar` is the shared element of the Table/Chart view
          transition: it is identical across both views, so naming it makes it
          morph in place while the rest of the pane crossfades. */}
      <div className="results-toolbar flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
        <ResultsSummary rowCount={result.rowCount} executionMs={result.executionMs} />
        {pending ? (
          // The stale summary stays while a re-run refreshes the rows; this
          // says a refresh is in flight.
          <span className="font-mono text-2xs text-muted">running…</span>
        ) : null}
        {result.unlocked && currentUser?.role !== 'admin' ? (
          <Badge tone="warn">unlocked</Badge>
        ) : null}
        {result.warnings.length > 0 ? (
          <Badge tone="warn">{result.warnings.length} warnings</Badge>
        ) : null}
        {result.masked ? (
          <Badge tone="warn">
            <EyeOff size={12} /> sensitive values masked
          </Badge>
        ) : result.columns.some((column) => column.sensitive) ? (
          <Badge tone="danger">
            <Eye size={12} /> sensitive values visible
          </Badge>
        ) : null}
        {!isMutation && result.rows.length > 0 ? (
          <div
            className={cn(
              'flex items-center gap-1',
              // While a re-run is in flight the filter reads stale rows, so it
              // is visually idled instead of accepting input (SearchInput has
              // no disabled prop, and ui/ is shared).
              pending && 'pointer-events-none opacity-50',
            )}
          >
            <SearchInput
              value={filterDraft}
              onChange={setFilterDraft}
              placeholder="Filter rows…"
              className="w-44"
            />
            {filterDraft ? (
              <IconButton label="Clear filter" onClick={() => setFilterDraft('')}>
                <X size={12} />
              </IconButton>
            ) : null}
            <FilterReadout filter={filter} matched={sortedRows.length} total={result.rows.length} />
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {!isMutation && result.rows.length > 0 ? (
            <div role="group" aria-label="Result view" className="mr-1">
              <Segmented
                options={[
                  { value: 'table', label: 'Table' },
                  { value: 'chart', label: 'Chart' },
                ]}
                value={view}
                onChange={handleViewChange}
              />
            </div>
          ) : null}
          {result.masked && onReveal ? (
            <Button
              variant="tertiary"
              size="sm"
              icon={<Eye size={12} />}
              onClick={() => setRevealOpen(true)}
            >
              Reveal
            </Button>
          ) : null}
          <div className="relative" ref={copyMenuRef}>
            <Button
              variant="tertiary"
              size="sm"
              icon={<Copy size={12} />}
              onClick={() => setCopyMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={copyMenuOpen}
              // Copying the page reads the stale rows while a re-run refreshes
              // them, so the menu idles with the table.
              disabled={result.columns.length === 0 || pending}
            >
              Copy
              <ChevronDown size={11} className={cn('transition', copyMenuOpen && 'rotate-180')} />
            </Button>
            {/* The items stay in the DOM while closed (`hidden`), so the menu
                is plain markup that tests can see. While closing it stays
                mounted a moment longer to pop back into the button. */}
            <div
              role="menu"
              hidden={!copyMenuOpen && !copyMenuClosing}
              className={cn(
                'absolute right-0 top-full z-30 mt-1 min-w-40 overflow-hidden rounded-xl border border-line bg-panel-2 py-1 shadow-lg',
                copyMenuOpen && 'pop-in',
                // `opacity-0` holds the menu invisible between the end of the
                // pop-out animation and the unmount timer, whatever fill mode
                // the utility uses.
                copyMenuClosing && 'pop-out opacity-0',
              )}
              style={{ '--pop-origin': 'top right' } as CSSProperties}
            >
              {COPY_FORMATS.map((format) => (
                <button
                  key={format.key}
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-2xs text-ink-soft hover:bg-panel-3"
                  onClick={() => void copyAs(format.key)}
                >
                  {format.label}
                </button>
              ))}
              {/* The file exports live in the menu rather than as toolbar
                  buttons: at narrow pane widths the toolbar was wrapping into
                  a dense band that sat right on the statusbar. */}
              <div className="my-1 border-t border-line-soft" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-ink-soft hover:bg-panel-3 disabled:opacity-50"
                onClick={exportCsv}
                disabled={result.columns.length === 0}
              >
                <Download size={12} /> Download CSV
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-ink-soft hover:bg-panel-3 disabled:opacity-50"
                onClick={exportJson}
                disabled={result.columns.length === 0}
              >
                <FileJson size={12} /> Download JSON
              </button>
            </div>
          </div>
        </div>
      </div>

      {result.truncated ? (
        <div className="border-b border-warn/20 bg-warn/5 px-3 py-2 text-2xs text-warn">
          Result capped at {formatNumber(result.rowCount)} rows — adjust the cap in Settings.
        </div>
      ) : null}

      {view === 'chart' && !isMutation && result.rows.length > 0 ? (
        <div className="border-b border-line-soft px-3 py-2">
          <ChartConfigRow columns={result.columns} config={chartConfig} onChange={updateChart} />
        </div>
      ) : null}

      {isMutation ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-mint/25 bg-mint/10 text-mint">
              <Rows3 size={20} />
            </div>
            <div className="mt-3 text-md font-bold">Statement completed</div>
            <div className="mt-1 text-xs text-muted">{result.info || 'No rows returned.'}</div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-left">
              <div className="stat">
                <div className="stat-label">Affected rows</div>
                <div className="stat-value">{formatNumber(result.affectedRows)}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Insert ID</div>
                <div className="stat-value text-base">{result.insertId ?? '—'}</div>
              </div>
            </div>
            <div className="mt-3 font-mono text-2xs text-muted">
              {result.kind} · {formatDuration(result.executionMs)}
            </div>
          </div>
        </div>
      ) : result.rows.length === 0 ? (
        <EmptyState icon={<Rows3 size={20} />} title="No rows returned" />
      ) : view === 'chart' ? (
        <ResultChart columns={result.columns} rows={filteredRows} config={chartConfig} />
      ) : (
        <ResultsTable
          columns={result.columns}
          rows={rows}
          rowOffset={currentPage * pageSize}
          sort={sort}
          pending={pending}
          // Sorting reads the stale rows; the header handler is dropped while
          // a re-run refreshes them.
          onSortClick={pending ? undefined : handleSortClick}
          onCellClick={handleCellClick}
        />
      )}

      {!isMutation && result.rows.length > 0 && view === 'table' ? (
        <div className="flex items-center justify-between gap-2 border-t border-line-soft px-3 py-2 text-2xs text-muted">
          {/* Page info only: the toolbar summary already carries the row
              count, so the total is not repeated here. The cap appears in the
              truncation note, where the cap itself is the information. */}
          <span className="num">
            Page {currentPage + 1} of {totalPages} · showing {currentPage * pageSize + 1}–
            {Math.min(sortedRows.length, (currentPage + 1) * pageSize)}
            {result.truncated ? ` (result capped at ${result.rowCount})` : null}
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5">
              Rows
              <select
                className="select w-auto py-1 text-2xs"
                value={pageSize}
                onChange={(event) => setPageSize(Number(event.target.value))}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1">
              <Button
                variant="tertiary"
                size="sm"
                icon={<ArrowLeft size={12} />}
                disabled={currentPage === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                Prev
              </Button>
              <Button
                variant="tertiary"
                size="sm"
                disabled={currentPage >= totalPages - 1}
                onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))}
              >
                Next <ArrowRight size={12} />
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        open={inspected !== null}
        onClose={() => setInspected(null)}
        size="wide"
        title={
          inspectedColumn ? (
            <span className="inline-flex items-center gap-1.5">
              {inspectedColumn.sensitive ? <Lock size={11} className="text-warn" /> : null}
              {inspectedColumn.name}
            </span>
          ) : null
        }
        subtitle={
          inspected ? (
            <span className="font-mono text-2xs text-muted">
              row {inspected.rowIndex + currentPage * pageSize + 1}
              {inspectedColumn ? ` · ${inspectedColumn.typeName}` : ''}
            </span>
          ) : null
        }
        footer={
          inspected ? <CopyButton text={cellText(inspected.value)} label="Copy raw value" /> : null
        }
      >
        {inspected ? (
          <div className="space-y-3">
            {result.masked && typeof inspected.value === 'string' ? (
              <div className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-2xs text-warn">
                This value is masked by the sensitivity policy — the original is not available in
                the browser.
              </div>
            ) : null}
            <CellInspectorBody value={inspected.value} />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={revealOpen}
        onClose={() => setRevealOpen(false)}
        onConfirm={() => {
          setRevealOpen(false);
          onRevealRef.current?.();
        }}
        title="Reveal sensitive values?"
        message="Re-runs the statement with sensitive columns unmasked. The result may contain credentials or personal data."
        confirmLabel="Reveal values"
        danger
      />
    </div>
  );
}

/**
 * Only a new result, the pending flag, or the arrival/removal of a reveal
 * handler can change what the grid renders, so compare those and ignore
 * callback identity churn.
 */
export const ResultsGrid = memo(
  ResultsGridBase,
  (previous, next) =>
    previous.result === next.result &&
    previous.pending === next.pending &&
    Boolean(previous.onReveal) === Boolean(next.onReveal),
);
