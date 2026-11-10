import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CellValue, QueryColumn, QueryResult } from '@shared/types';
import { ChartConfigRow, FilterReadout, ResultsGrid, ResultsTable } from '@/components/ResultsGrid';
import { ResultChart } from '@/components/ResultChart';
import { defaultChartConfig, type ChartConfig } from '@/lib/chart-data';
import { sortRows } from '@/lib/format';

/**
 * D-18 — the rightmost column of the results grid was cut off mid-word at the
 * pane edge (`Co…` / `G…`) with only a vertical scrollbar on the pane, so a
 * wide result set read as data loss instead of overflow.
 *
 * The table used to be laid out at `width: 100%`, so the browser squeezed the
 * last column until its values were clipped, and the pane never had anything
 * to scroll sideways. The grid now keeps the table at its natural width and
 * scrolls it in both directions, so the overflow is visible.
 */

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

const result: QueryResult = {
  sql: 'SELECT CustomerID, CustomerName, Country FROM customers',
  database: 'northwind',
  kind: 'read',
  columns,
  rows: [
    [3, 'Cherry', 'Germany'],
    [1, 'Apple', 'Mexico'],
    [2, 'Banana', 'Germany'],
  ],
  rowCount: 3,
  truncated: false,
  affectedRows: 0,
  insertId: null,
  info: '',
  warnings: [],
  executionMs: 5,
  bytesApprox: 2048,
  unlocked: false,
  masked: false,
};

describe('results table', () => {
  it('scrolls sideways so a wide result set can be read', () => {
    const html = renderToStaticMarkup(
      <ResultsTable
        columns={columns}
        rows={[
          [1, 'Alfreds Futterkiste', 'Germany'],
          [2, 'Ana Trujillo Emparedados', 'Mexico'],
        ]}
      />,
    );
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('overflow-y-auto');
  });

  it('keeps the table at its natural width instead of squeezing the last column', () => {
    const html = renderToStaticMarkup(
      <ResultsTable columns={columns} rows={[[1, 'Alfreds Futterkiste', 'Germany']]} />,
    );
    expect(html).toContain('min-w-max');
  });

  it('still renders every column and row', () => {
    const html = renderToStaticMarkup(
      <ResultsTable columns={columns} rows={[[1, 'Alfreds Futterkiste', 'Germany']]} />,
    );
    expect(html).toContain('Country');
    expect(html).toContain('Alfreds Futterkiste');
    expect(html).toContain('Germany');
  });
});

/**
 * A truncated result used to show "showing X–Y of N" with N being the row
 * cap, as if the cap were the total. The readout now admits the cap, and the
 * footer carries a page-size selector (50/100/250) in component state.
 *
 * The footer also no longer repeats the total — the toolbar summary above it
 * already carries the row count, so the footer keeps the page info only, and
 * the cap appears in the truncation note where the cap is the information.
 */
describe('results pagination', () => {
  const capped: QueryResult = {
    sql: 'SELECT CustomerID FROM customers',
    database: 'northwind',
    kind: 'read',
    columns: [columns[0]],
    rows: Array.from({ length: 250 }, (_, index) => [index + 1]),
    rowCount: 250,
    truncated: true,
    affectedRows: 0,
    insertId: null,
    info: '',
    warnings: [],
    executionMs: 5,
    bytesApprox: 2048,
    unlocked: false,
    masked: false,
  };

  it('says the result is capped instead of implying the cap is the total', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={capped} />);
    expect(html).toContain('showing 1–100 (result capped at 250)');
  });

  it('keeps only the page info in the footer, leaving the total to the toolbar', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={capped} />);
    expect(html).toContain('Page 1 of 3 · showing 1–100');
    // The toolbar summary shows "250 rows"; the footer must not echo it.
    expect(html).not.toContain('of 250');
    expect(html).toContain('250 rows');
  });

  it('leaves the plain readout for a result that was not capped', () => {
    const full = { ...capped, rows: capped.rows.slice(0, 250), truncated: false };
    const html = renderToStaticMarkup(<ResultsGrid result={full} />);
    expect(html).not.toContain('result capped at');
  });

  it('offers the 50/100/250 page sizes in the footer', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={capped} />);
    expect(html).toContain('>50</option>');
    expect(html).toContain('>100</option>');
    expect(html).toContain('>250</option>');
  });
});

/**
 * The grid says "masked" once, in its toolbar badge; the per-column header
 * locks are gone (the inspector's masked note keeps its own lock, but no
 * inspector is open in a static render).
 */
describe('masked state surface', () => {
  const masked: QueryResult = {
    ...result,
    columns: columns.map((column) => ({ ...column, sensitive: true })),
    masked: true,
  };

  it('shows the toolbar badge and no per-column lock icons', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={masked} />);
    expect(html).toContain('sensitive values masked');
    expect(html).not.toContain('lucide-lock');
  });
});

/**
 * A re-run over an existing result keeps the grid mounted: five skeleton rows
 * stand in for the stale rows, the toolbar stays (summary plus a quiet
 * "running…"), and the sort/filter/copy interactions idle until the new
 * result lands. Only a first run — no result yet — swaps the pane for the
 * running indicator (that swap lives in WorkspacePage).
 */
describe('pending state', () => {
  it('renders skeleton rows instead of data while pending', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={result} pending />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('skeleton');
    expect(html).not.toContain('Cherry');
  });

  it('keeps the toolbar with its summary and a running note', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={result} pending />);
    expect(html).toContain('3 rows');
    expect(html).toContain('running…');
  });

  it('renders data rows and no running note when not pending', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={result} />);
    expect(html).toContain('Cherry');
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('running…');
  });

  it('drops the header sort affordance while pending', () => {
    const html = renderToStaticMarkup(
      <ResultsTable columns={columns} rows={result.rows} pending />,
    );
    expect(html).not.toContain('cursor-pointer');
    expect(html).toContain('skeleton');
  });
});

/**
 * Clicking a header cycles asc → desc → off. The sorted column carries an
 * arrow (lucide) and an `aria-sort` value; unsorted headers carry neither.
 */
describe('column sort indicator', () => {
  it('marks the sorted column with its direction', () => {
    const ascending = renderToStaticMarkup(
      <ResultsTable columns={columns} rows={result.rows} sort={{ column: 1, dir: 'asc' }} />,
    );
    expect(ascending).toContain('aria-sort="ascending"');
    expect(ascending).toContain('lucide-arrow-up');

    const descending = renderToStaticMarkup(
      <ResultsTable columns={columns} rows={result.rows} sort={{ column: 1, dir: 'desc' }} />,
    );
    expect(descending).toContain('aria-sort="descending"');
    expect(descending).toContain('lucide-arrow-down');
  });

  it('leaves headers unmarked when nothing is sorted', () => {
    const html = renderToStaticMarkup(<ResultsTable columns={columns} rows={result.rows} />);
    expect(html).not.toContain('aria-sort');
    expect(html).not.toContain('lucide-arrow');
  });
});

/**
 * The grid sorts the full in-memory row set (not just the page) with the
 * numeric-aware comparator from `format.ts`; what lands on screen is the
 * sorted order.
 */
describe('column sort ordering', () => {
  it('renders the rows in the sorted order', () => {
    const ascending = renderToStaticMarkup(
      <ResultsTable columns={columns} rows={sortRows(result.rows, 0, 'asc')} />,
    );
    expect(ascending.indexOf('Apple')).toBeLessThan(ascending.indexOf('Banana'));
    expect(ascending.indexOf('Banana')).toBeLessThan(ascending.indexOf('Cherry'));

    const descending = renderToStaticMarkup(
      <ResultsTable columns={columns} rows={sortRows(result.rows, 0, 'desc')} />,
    );
    expect(descending.indexOf('Cherry')).toBeLessThan(descending.indexOf('Apple'));
  });

  it('sorts before pagination with the grid pipeline', () => {
    // The render-time pipeline: filter the full set, then sort it, then page
    // it — the same order the user sees.
    const source = readFileSync(
      new URL('../src/components/ResultsGrid.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('filterRows(result.rows, filter)');
    expect(source).toContain('sortRows(filteredRows, sort.column, sort.dir)');
    expect(source.indexOf('filterRows(result.rows, filter)')).toBeLessThan(
      source.indexOf('sortRows(filteredRows, sort.column, sort.dir)'),
    );
  });
});

/**
 * The quick filter matches the displayed text of a cell (so masked cells
 * match their masked form) and reports how many rows it kept.
 */
describe('quick filter', () => {
  it('shows the match readout while a filter is active', () => {
    const html = renderToStaticMarkup(<FilterReadout filter="ger" matched={2} total={12} />);
    expect(html).toContain('2 of 12 rows match');
  });

  it('shows nothing while the filter is empty', () => {
    const html = renderToStaticMarkup(<FilterReadout filter="" matched={12} total={12} />);
    expect(html).not.toContain('rows match');
  });

  it('offers a clearable filter input above the grid', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={result} />);
    expect(html).toContain('Filter rows');
    // The clear affordance only exists once the user has typed something, so
    // it is checked at the source level.
    const source = readFileSync(
      new URL('../src/components/ResultsGrid.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('label="Clear filter"');
    expect(source).toContain("setFilterDraft('')");
  });
});

/**
 * Clipboard copy grew from JSON-only into a menu of formats. The items stay
 * in the DOM while the menu is closed, so the closed menu is plain markup.
 */
describe('copy-as menu', () => {
  it('offers JSON, TSV, Markdown and SQL INSERT formats', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={result} />);
    expect(html).toContain('Copy JSON');
    expect(html).toContain('Copy TSV');
    expect(html).toContain('Copy Markdown');
    expect(html).toContain('Copy SQL INSERT');
  });

  it('keeps the file exports in the menu, not as toolbar buttons', () => {
    const source = readFileSync(
      new URL('../src/components/ResultsGrid.tsx', import.meta.url),
      'utf8',
    );
    const html = renderToStaticMarkup(<ResultsGrid result={result} />);
    // The toolbar renders a single Copy trigger; CSV/JSON export moved into
    // the menu so the toolbar stops wrapping into the statusbar at narrow
    // pane widths.
    expect(html).toContain('Download CSV');
    expect(html).toContain('Download JSON');
    expect(source).not.toMatch(/icon=\{<Download size=\{12\} \/>\}[\s\S]{0,80}>\s*\{\s*'CSV'/);
    expect(source).toMatch(/exportCsv\}/);
  });

  it('copies the displayed page with the same helpers the tests cover', () => {
    const source = readFileSync(
      new URL('../src/components/ResultsGrid.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('toTsv(result.columns, rows)');
    expect(source).toContain('toMarkdownTable(result.columns, rows)');
    expect(source).toContain('toSqlInsert(sqlInsertTarget(result.columns), result.columns, rows)');
  });

  it('opens a cell inspector from a cell click', () => {
    const source = readFileSync(
      new URL('../src/components/ResultsGrid.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('onCellClick={handleCellClick}');
    expect(source).toContain('Copy raw value');
  });
});

/**
 * Work package 9 — query-result charting. The toolbar grows a Table/Chart
 * toggle (a segmented control, like elsewhere in the app); chart view swaps
 * the table for the `ResultChart` SVG plus a compact config row. Static
 * markup cannot click the toggle, so what only exists in chart view is
 * checked at the source level, the way the copy-menu tests above do.
 */
describe('chart view wiring', () => {
  it('offers a table/chart toggle in the toolbar', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={result} />);
    expect(html).toContain('aria-label="Result view"');
    expect(html).toContain('>Table</button>');
    expect(html).toContain('>Chart</button>');
  });

  it('hides the toggle when there is nothing to chart', () => {
    const empty: QueryResult = { ...result, rows: [], rowCount: 0 };
    const html = renderToStaticMarkup(<ResultsGrid result={empty} />);
    expect(html).not.toContain('aria-label="Result view"');
    expect(html).toContain('No rows returned');
  });

  it('starts in table view, and chart view swaps the table for the chart', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={result} />);
    expect(html).toContain('Filter rows');
    const source = readFileSync(
      new URL('../src/components/ResultsGrid.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain(
      '<ResultChart columns={result.columns} rows={filteredRows} config={chartConfig} />',
    );
    // Charts read the quick-filtered rows but not the sort — chart data
    // applies its own ordering policy.
    expect(source.indexOf('rows={filteredRows}')).toBeGreaterThan(-1);
  });

  it('keeps the pagination footer for the table view only', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={result} />);
    expect(html).toContain('Page 1 of 1');
    const source = readFileSync(
      new URL('../src/components/ResultsGrid.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain("result.rows.length > 0 && view === 'table'");
  });

  it('resets the view and the chart config on a new result', () => {
    const source = readFileSync(
      new URL('../src/components/ResultsGrid.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain("setView('table')");
    expect(source).toContain('setChartConfigDraft(null)');
  });

  it('renders the chart config controls', () => {
    const config: ChartConfig = { type: 'bar', xColumn: 2, yColumn: 0, agg: 'sum' };
    const html = renderToStaticMarkup(
      <ChartConfigRow columns={columns} config={config} onChange={() => {}} />,
    );
    expect(html).toContain('aria-label="Chart type"');
    expect(html).toContain('aria-label="Chart X column"');
    expect(html).toContain('aria-label="Chart Y column"');
    expect(html).toContain('aria-label="Chart aggregation"');
    expect(html).toContain('>Bar</option>');
    expect(html).toContain('>Sum</option>');
    expect(html).toContain('>Country</option>');
    // Count works on any column, so the Y select is irrelevant and disabled.
    const counting = renderToStaticMarkup(
      <ChartConfigRow columns={columns} config={{ ...config, agg: 'count' }} onChange={() => {}} />,
    );
    expect(counting).toContain('disabled');
  });

  it('offers None only for line and scatter, which plot raw points', () => {
    const line = renderToStaticMarkup(
      <ChartConfigRow
        columns={columns}
        config={{ type: 'line', xColumn: 0, yColumn: 1, agg: 'none' }}
        onChange={() => {}}
      />,
    );
    expect(line).toContain('>None</option>');
    const bar = renderToStaticMarkup(
      <ChartConfigRow
        columns={columns}
        config={{ type: 'bar', xColumn: 0, yColumn: 1, agg: 'sum' }}
        onChange={() => {}}
      />,
    );
    expect(bar).not.toContain('>None</option>');
  });
});

/**
 * M3 — content-level motion. The copy menu pops in from its trigger and pops
 * back into it through a kept-mounted closing state (the workspace format
 * menu's pattern), the Table/Chart toggle crossfades through the View
 * Transitions API with the toolbar as the shared element, and the data body
 * mask-reveals once per re-run.
 */
describe('M3 motion wiring', () => {
  const source = readFileSync(
    new URL('../src/components/ResultsGrid.tsx', import.meta.url),
    'utf8',
  );
  const viewCss = readFileSync(
    new URL('../src/styles/features/misc-pages.css', import.meta.url),
    'utf8',
  );

  it('pops the copy menu in from its trigger and keeps it mounted through the exit', () => {
    // Open: pop-in anchored to the right-aligned menu's trigger.
    expect(source).toContain("copyMenuOpen && 'pop-in'");
    expect(source).toContain("'--pop-origin': 'top right'");
    // Closing: kept mounted with pop-out until the unmount timer (130ms for
    // the 120ms pop-out), mirroring the workspace format menu.
    expect(source).toContain("copyMenuClosing && 'pop-out opacity-0'");
    expect(source).toContain('if (copyMenuOpen !== copyMenuWasOpen)');
    expect(source).toContain('COPY_MENU_EXIT_MS');
    expect(source).toContain('hidden={!copyMenuOpen && !copyMenuClosing}');
  });

  it('crossfades the table/chart toggle through the View Transitions API', () => {
    // Feature-detected; the React 19 pattern flushes the state change inside
    // the transition callback, and the fallback stays a plain setView.
    expect(source).toMatch(
      /startViewTransition[\s\S]*?flushSync\(\(\) => setView\(next\)\)[\s\S]*?setView\(next\);/,
    );
    // The toolbar is identical across both views, so naming it makes it morph
    // while the root crossfades at the fast duration.
    expect(source).toContain('results-toolbar');
    expect(viewCss).toContain('.results-toolbar');
    expect(viewCss).toContain('view-transition-name: results-toolbar');
    expect(viewCss).toContain('::view-transition-old(root),');
    expect(viewCss).toContain('animation-duration: var(--duration-fast)');
  });

  it('reveals the data body with a mask once per re-run', () => {
    // The tbody remounts on the pending → data swap, so the reveal replays
    // per run and never on ordinary renders (sort, filter, paging).
    expect(source).toContain("key={pending ? 'pending' : 'data'}");
    expect(source).toContain("'mask-reveal'");
  });
});

describe('result chart', () => {
  it('renders an SVG with a Download SVG button for the default config', () => {
    const rows: (string | number)[][] = [
      [1, 'Apple', 'Germany'],
      [2, 'Banana', 'Germany'],
    ];
    const html = renderToStaticMarkup(
      <ResultChart columns={columns} rows={rows} config={defaultChartConfig({ columns, rows })} />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('Download SVG');
    // Default: first string-ish column on X, first numeric column on Y.
    expect(html).toContain('sum of CustomerID by CustomerName');
  });

  it('renders bar, line, scatter and pie bodies with tooltips', () => {
    const rows: CellValue[][] = [
      ['1', 'A', 'Germany'],
      ['2', 'B', 'Germany'],
      ['3', 'C', 'Mexico'],
    ];
    for (const type of ['bar', 'line', 'scatter', 'pie'] as const) {
      const config: ChartConfig = { type, xColumn: 2, yColumn: 0, agg: 'sum' };
      const html = renderToStaticMarkup(
        <ResultChart columns={columns} rows={rows} config={config} />,
      );
      expect(html).toContain('<svg');
      expect(html).toContain('<title>');
    }
  });

  it('gives the pie a legend with values and percentages', () => {
    const rows: CellValue[][] = [
      ['1', 'A', 'Germany'],
      ['2', 'B', 'Germany'],
      ['3', 'C', 'Mexico'],
    ];
    const html = renderToStaticMarkup(
      <ResultChart
        columns={columns}
        rows={rows}
        config={{ type: 'pie', xColumn: 2, yColumn: 0, agg: 'count' }}
      />,
    );
    expect(html).toContain('Germany');
    expect(html).toContain('Mexico');
    expect(html).toContain('%');
  });

  it('shows a friendly empty state for an empty result', () => {
    const html = renderToStaticMarkup(
      <ResultChart
        columns={columns}
        rows={[]}
        config={defaultChartConfig({ columns, rows: [] })}
      />,
    );
    expect(html).toContain('Nothing to chart');
  });

  it('explains itself when no row has a numeric Y value', () => {
    const html = renderToStaticMarkup(
      <ResultChart
        columns={columns}
        rows={[['1', 'Cherry', 'Germany']]}
        config={{ type: 'line', xColumn: 1, yColumn: 1, agg: 'none' }}
      />,
    );
    expect(html).toContain('No numeric values to plot');
    expect(html).toContain('masked and non-numeric cells are excluded');
  });

  it('declines a pie whose buckets are all zero or negative', () => {
    const html = renderToStaticMarkup(
      <ResultChart
        columns={columns}
        rows={[
          ['-1', 'A', 'Germany'],
          ['-2', 'B', 'Mexico'],
        ]}
        config={{ type: 'pie', xColumn: 1, yColumn: 0, agg: 'sum' }}
      />,
    );
    expect(html).toContain('No positive values to chart');
  });
});
