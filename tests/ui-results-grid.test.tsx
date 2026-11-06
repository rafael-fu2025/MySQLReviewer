import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueryColumn } from '@shared/types';
import { ResultsTable } from '@/components/ResultsGrid';

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
