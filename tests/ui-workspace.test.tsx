import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueryResult } from '@shared/types';
import { AiAssistant } from '@/components/AiAssistant';
import { ResultsGrid } from '@/components/ResultsGrid';
import { OutputMeta, OutputPane } from '@/pages/WorkspacePage';

/**
 * D-17 — the floating assistant button sat in the bottom-right corner of the
 * window, on top of the last rows of the results grid and over the status
 * bar along the bottom edge.
 *
 * D-19 — the row count and the duration were shown twice: `20 ms · 12 rows` in
 * the output strip above the grid, and `12 rows · 20 ms` in the grid's own
 * toolbar right below it.
 */

const result: QueryResult = {
  sql: 'SELECT CustomerID, CustomerName, Country FROM customers',
  database: 'northwind',
  kind: 'read',
  columns: [
    {
      name: 'CustomerID',
      originalName: 'CustomerID',
      table: 'customers',
      database: 'northwind',
      typeName: 'INT',
      typeCode: 3,
      flags: 0,
    },
  ],
  rows: Array.from({ length: 12 }, (_, index) => [index + 1]),
  rowCount: 12,
  truncated: false,
  affectedRows: 0,
  insertId: null,
  info: '',
  warnings: [],
  executionMs: 20,
  bytesApprox: 1024,
  unlocked: false,
  masked: false,
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function renderAssistant(bottomInset: number): string {
  return renderToStaticMarkup(
    <AiAssistant
      mode="workspace"
      title="Assistant"
      notice="Full help on the statement in the editor and the schema behind it."
      emptyHint="Ask about the statement in the editor."
      placeholder="Ask about this statement…"
      context={{ profileId: null, database: null, sql: 'SELECT 1' }}
      bottomInset={bottomInset}
    />,
  );
}

describe('workspace assistant button', () => {
  it('is lifted clear of the status bar', () => {
    // The status bar is 26px tall; the button has to sit above it.
    expect(renderAssistant(26)).toContain('bottom:calc(var(--ai-fab-bottom) + 26px)');
  });

  it('leaves room for the button under the last row of the output', () => {
    // The band follows the button's own offset: its height plus a clearance.
    const html = renderToStaticMarkup(
      <OutputPane>
        <div>rows</div>
      </OutputPane>,
    );
    expect(html).toContain('padding-bottom:calc(var(--ai-fab-bottom) + 62px)');
  });
});

describe('workspace result summary', () => {
  it('shows the row count and the duration once', () => {
    const grid = renderToStaticMarkup(<ResultsGrid result={result} />);
    expect(countOccurrences(grid, '20 ms')).toBe(1);
    expect(countOccurrences(grid, '12 rows')).toBe(1);

    // The strip above the grid must not repeat the same pair: a duration
    // followed by the row count.
    const source = readFileSync(new URL('../src/pages/WorkspacePage.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/formatDuration\([^)]*executionMs\)\}?\s*·/);
  });

  it('leaves the rest of the output strip alone', () => {
    const strip = renderToStaticMarkup(
      <OutputMeta score={91} hasAi resultsMaximized={false} onToggleMaximized={() => {}} />,
    );
    expect(strip).toContain('score 91');
    expect(strip).toContain('AI');
    expect(strip).toContain('Maximize');
    expect(strip).not.toContain('20 ms');
    expect(strip).not.toContain('12 rows');
  });
});
