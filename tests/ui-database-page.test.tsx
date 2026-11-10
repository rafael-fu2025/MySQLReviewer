import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DatabaseHeaderActions, DatabaseStatGrid, TableLink } from '../src/pages/DatabasePage';
import type { TableSummary } from '../shared/types';

/**
 * D-09, D-21, D-22 — the database page.
 *
 * The page itself reads the app store, so the parts under test are rendered
 * as presentational components with plain props.
 */

const table: TableSummary = {
  database: 'northwind',
  name: 'customers',
  type: 'BASE TABLE',
  engine: 'InnoDB',
  rowsEstimate: 830,
  dataBytes: 12288,
  indexBytes: 4096,
  dataFreeBytes: 0,
  collation: 'utf8mb4_general_ci',
  comment: '',
  createdAt: null,
  updatedAt: null,
};

/** The class list of the button that carries the given label. */
function buttonClass(html: string, label: string): string {
  const index = html.indexOf(`${label}</button>`);
  expect(index).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<button', index);
  const classIndex = html.indexOf('class="', start);
  const end = html.indexOf('"', classIndex + 7);
  return html.slice(classIndex + 7, end);
}

/** The class list of the closest element that wraps the given text. */
function wrapperClass(html: string, text: string): string {
  const index = html.indexOf(text);
  expect(index).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div', index);
  const classIndex = html.indexOf('class="', open);
  const end = html.indexOf('"', classIndex + 7);
  return html.slice(classIndex + 7, end);
}

/** The class list of the stat grid container. */
function gridClass(html: string): string {
  const index = html.indexOf('class="stat-grid');
  expect(index).toBeGreaterThan(-1);
  const end = html.indexOf('"', index + 7);
  return html.slice(index + 7, end);
}

/** The visible text of a markup fragment, without the tags. */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function renderActions(): string {
  return renderToStaticMarkup(
    <DatabaseHeaderActions
      canAct
      onExport={() => {}}
      onImport={() => {}}
      onCreate={() => {}}
      onRefresh={() => {}}
    />,
  );
}

function renderCard(): string {
  return renderToStaticMarkup(<TableLink table={table} onOpen={() => {}} />);
}

describe('database page header actions (D-09)', () => {
  it('keeps the import action in a group of its own', () => {
    const html = renderActions();
    // The import is not the export: it sits in its own group instead of
    // standing next to it as another plain secondary button.
    expect(wrapperClass(html, 'Import SQL')).not.toBe(wrapperClass(html, 'Export SQL'));
  });

  it('marks the import group with a warning tone', () => {
    const html = renderActions();
    expect(wrapperClass(html, 'Import SQL')).toMatch(/border-warn/);
  });

  it('says that the import can change data', () => {
    expect(renderActions()).toContain('can modify data');
  });

  it('leaves the primary action of the page to create database', () => {
    const html = renderActions();
    expect(buttonClass(html, 'Create database')).toContain('button-primary');
    expect(buttonClass(html, 'Import SQL')).not.toContain('button-primary');
    expect(buttonClass(html, 'Export SQL')).not.toContain('button-primary');
  });

  it('keeps the read-only export a plain secondary action', () => {
    const html = renderActions();
    expect(buttonClass(html, 'Export SQL')).toContain('button-secondary');
    expect(wrapperClass(html, 'Export SQL')).not.toMatch(/border-warn/);
  });
});

describe('table card metadata (D-21)', () => {
  it('keeps a size unit on the same line as its number', () => {
    const text = textOf(renderCard());
    expect(text).toContain('16.0\u00A0KB');
    expect(text).not.toContain('16.0 KB');
  });

  it('keeps a row count on the same line as its number', () => {
    const text = textOf(renderCard());
    expect(text).toContain('830\u00A0rows');
  });

  it('never leaves a separator at the end of a line', () => {
    const text = textOf(renderCard());
    // Every separator is bound to the part that follows it with a
    // non-breaking space, so a wrap can never strand a "·" at the end of a
    // line: it always travels with what comes next.
    expect(text).not.toMatch(/·(?![\u00A0])/);
  });

  it('still reads as engine, rows and size', () => {
    const text = textOf(renderCard());
    expect(text).toContain('InnoDB');
    expect(text).toContain('rows');
    expect(text).toContain('KB');
  });
});

describe('database stat tiles (D-22)', () => {
  function renderGrid(): string {
    return renderToStaticMarkup(
      <DatabaseStatGrid
        tables={12}
        views={3}
        routines={0}
        triggers={4}
        events={0}
        totalSize={16384}
      />,
    );
  }

  it('gives both rows of the grid the same height', () => {
    const html = renderGrid();
    // The grid declares equal auto rows, so the tile that carries a second
    // line cannot stretch its row past the other one.
    expect(gridClass(html)).toMatch(/auto-rows-\[1fr\]/);
  });

  it('still renders all six counters', () => {
    const html = renderGrid();
    for (const label of ['Tables', 'Views', 'Routines', 'Triggers', 'Events', 'Total size']) {
      expect(html).toContain(label);
    }
  });

  it('keeps the size breakdown on the total size tile', () => {
    expect(renderGrid()).toContain('data + indexes');
  });
});
