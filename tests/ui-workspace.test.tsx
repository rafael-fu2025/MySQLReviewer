import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueryResult } from '@shared/types';
import { AiAssistant } from '@/components/AiAssistant';
import { ResultsGrid } from '@/components/ResultsGrid';
import { CopyButton } from '@/components/ui/button';
import { OutputMeta, OutputPane, resistSplit } from '@/pages/WorkspacePage';
import { DEFAULT_FORMAT_OPTIONS, sqlFormatterOptions } from '@/lib/sql-snippets';
import { useUiStore } from '@/store/ui-store';

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
  it('is lifted clear of the status bar and the pagination footer', () => {
    // 26px status bar + 40px footer band + 8px gap: the button rests on the
    // grid's bottom-right corner instead of covering Prev/Next.
    expect(renderAssistant(74)).toContain('bottom:calc(var(--ai-fab-bottom) + 74px)');
    const source = readFileSync(new URL('../src/pages/WorkspacePage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('bottomInset={ASSISTANT_FAB_INSET}');
    expect(source).toContain(
      'const ASSISTANT_FAB_INSET = STATUS_BAR_HEIGHT + RESULTS_FOOTER_HEIGHT + ASSISTANT_CLEARANCE;',
    );
  });

  it('no longer reserves a dead band at the bottom of the output pane', () => {
    // The reservation pushed the pagination footer ~78px up and left a strip
    // of empty pane between it and the status bar.
    const html = renderToStaticMarkup(
      <OutputPane>
        <div>rows</div>
      </OutputPane>,
    );
    expect(html).not.toContain('padding-bottom');
  });
});

describe('workspace editor wiring', () => {
  const source = readFileSync(new URL('../src/pages/WorkspacePage.tsx', import.meta.url), 'utf8');

  it('inserts assistant proposals at the caret instead of replacing the tab SQL', () => {
    // Replacing the whole tab buffer wiped the statement the user had open.
    expect(source).toContain('onInsertSql={(sql) => insertText(sql)}');
    expect(source).not.toContain('onInsertSql={(sql) => updateSql');
  });

  it('binds the new statement tab to Alt+T, which browsers do not reserve', () => {
    // Ctrl/Cmd+T opens a browser tab and cannot be stopped with preventDefault.
    expect(source).toContain(
      "event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyT'",
    );
    expect(source).toContain('New statement tab (Alt+T)');
    expect(source).not.toContain("event.key.toLowerCase() === 't'");
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
      <OutputMeta hasAi resultsMaximized={false} onToggleMaximized={() => {}} />,
    );
    expect(strip).toContain('AI');
    expect(strip).toContain('Maximize');
    expect(strip).not.toContain('20 ms');
    expect(strip).not.toContain('12 rows');
    // The score badge moved out — the ReviewPanel's ScoreRing is the single
    // score surface, so the strip does not repeat it.
    expect(strip).not.toContain('score');
  });

  it('keeps the grid mounted on a re-run and swaps panes only for a first run', () => {
    const source = readFileSync(new URL('../src/pages/WorkspacePage.tsx', import.meta.url), 'utf8');
    // First run (no result yet) shows the running indicator; a re-run over an
    // existing result passes `pending` so the grid stays mounted.
    expect(source).toContain('activeTab.running && !activeTab.result');
    expect(source).toContain('pending={activeTab.running}');
  });
});

describe('format options', () => {
  afterEach(() => {
    // The ui store is a module singleton; put the defaults back so other
    // suites read a pristine state.
    useUiStore.getState().setFormatOptions({
      keywordCase: DEFAULT_FORMAT_OPTIONS.keywordCase,
      indent: DEFAULT_FORMAT_OPTIONS.indent,
      linesBetweenQueries: DEFAULT_FORMAT_OPTIONS.linesBetweenQueries,
    });
  });

  it('starts from the shared defaults', () => {
    const state = useUiStore.getState();
    expect(state.formatKeywordCase).toBe('upper');
    expect(state.formatIndent).toBe('2');
    expect(state.formatLinesBetweenQueries).toBe(2);
    expect(DEFAULT_FORMAT_OPTIONS).toEqual({
      keywordCase: 'upper',
      indent: '2',
      linesBetweenQueries: 2,
    });
  });

  it('patches only the keys it is given', () => {
    useUiStore.getState().setFormatOptions({ keywordCase: 'lower' });
    expect(useUiStore.getState().formatKeywordCase).toBe('lower');
    expect(useUiStore.getState().formatIndent).toBe('2');
    useUiStore.getState().setFormatOptions({ indent: 'tab', linesBetweenQueries: 1 });
    expect(useUiStore.getState().formatKeywordCase).toBe('lower');
    expect(useUiStore.getState().formatIndent).toBe('tab');
    expect(useUiStore.getState().formatLinesBetweenQueries).toBe(1);
  });

  it('maps the persisted shape onto sql-formatter invocation options', () => {
    expect(
      sqlFormatterOptions({ keywordCase: 'lower', indent: '4', linesBetweenQueries: 1 }),
    ).toEqual({ language: 'mysql', keywordCase: 'lower', tabWidth: 4, linesBetweenQueries: 1 });
    expect(
      sqlFormatterOptions({ keywordCase: 'preserve', indent: 'tab', linesBetweenQueries: 2 }),
    ).toEqual({
      language: 'mysql',
      keywordCase: 'preserve',
      useTabs: true,
      linesBetweenQueries: 2,
    });
  });

  it('keeps the options in the persisted ui store and out of resetLayout', () => {
    // Source check: the fields ride on the `mylens.ui.v1` persisted store.
    const source = readFileSync(new URL('../src/store/ui-store.ts', import.meta.url), 'utf8');
    expect(source).toContain("name: 'mylens.ui.v1'");
    expect(source).toContain('formatKeywordCase');
    expect(source).toContain('setFormatOptions');

    // Resetting the window layout must not silently change how the user
    // formats their SQL.
    useUiStore.getState().setFormatOptions({ keywordCase: 'preserve' });
    useUiStore.getState().resetLayout();
    expect(useUiStore.getState().formatKeywordCase).toBe('preserve');
  });
});

describe('format selection wiring', () => {
  const source = readFileSync(new URL('../src/pages/WorkspacePage.tsx', import.meta.url), 'utf8');

  it('formats only the selected range when there is one', () => {
    expect(source).toContain('view.state.sliceDoc(selection.from, selection.to)');
    expect(source).toContain(
      'changes: { from: selection.from, to: selection.to, insert: formatted }',
    );
  });

  it('falls back to formatting the whole buffer', () => {
    expect(source).toContain('updateSql(activeTab.id, formatted)');
  });

  it('reads its options from the ui store', () => {
    expect(source).toContain('sqlFormatterOptions(');
    expect(source).toContain('state.formatKeywordCase');
    expect(source).not.toContain("keywordCase: 'upper',\n        tabWidth: 2");
  });

  it('offers the options next to the Format button and feeds snippets to the editor', () => {
    expect(source).toContain('aria-label="Format options"');
    expect(source).toContain('role="menuitemradio"');
    expect(source).toContain('snippets={snippets}');
    // Saved snippets load on mount so they are offered as completions before
    // the snippets modal is ever opened.
    expect(source).toContain('dbApi.snippets()');
  });
});

describe('CopyButton success motion', () => {
  const source = readFileSync(new URL('../src/components/ui/button.tsx', import.meta.url), 'utf8');

  it('renders both icons stacked so the swap can animate', () => {
    const html = renderToStaticMarkup(<CopyButton text="SELECT 1" />);
    expect(html).toContain('icon-stack');
    // The resting copy icon crossfades in; the check waits hidden (.icon-off)
    // until a successful copy flips the classes.
    expect(html).toContain('icon-crossfade');
    expect(html).toContain('icon-off');
    expect(countOccurrences(html, '<svg')).toBe(2);
  });

  it('arms the icon crossfade and the success pulse on copy', () => {
    // Source check: a successful copy flips the stack classes and pulses the
    // button (the class is dropped on a timeout so it can replay).
    expect(source).toContain("copied ? 'icon-crossfade' : 'icon-off'");
    expect(source).toContain("pulse && 'pulse-success'");
  });
});

/**
 * M2 — the assistant panel opens from the FAB and returns into it (anchored
 * motion from the trigger), the splitter rubber-bands past its bounds and
 * snaps back, and the format menu pops from its caret.
 */

describe('assistant panel motion wiring', () => {
  const assistantSource = readFileSync(
    new URL('../src/components/AiAssistant.tsx', import.meta.url),
    'utf8',
  );
  const assistantCss = readFileSync(
    new URL('../src/styles/features/assistant.css', import.meta.url),
    'utf8',
  );

  it('keeps the panel mounted through a 200ms exit, then unmounts it', () => {
    // 200ms = the 250ms entrance less the ~20% exits shave; it must match
    // the `.ai-panel.closing` animation in assistant.css.
    expect(assistantSource).toContain('const PANEL_EXIT_MS = 200');
    // The kept-mounted closing state follows the modal's render adjustment.
    expect(assistantSource).toContain('if (open !== wasOpen)');
    expect(assistantSource).toContain('setMounted(false)');
    // The exit timer is cleaned up.
    expect(assistantSource).toContain('clearTimeout(timer)');
  });

  it('plays a trigger-anchored entrance and a shorter exit toward the FAB', () => {
    expect(assistantCss).toContain('@keyframes panel-from-trigger');
    expect(assistantCss).toContain('@keyframes panel-to-trigger');
    // Both animations start/end at the bottom-right trigger, never a center fade.
    expect(assistantCss).toContain('transform-origin: bottom right');
    // The entrance is an arc: individual translate/scale properties with an
    // asymmetric midpoint (x settles faster than y), not a straight diagonal.
    expect(assistantCss).toContain('translate: 24px 24px;');
    expect(assistantCss).toContain('scale: 0.95;');
    expect(assistantCss).toMatch(/45%[^}]*translate: 8px 18px/);
    // Exit runs `calc(0.25s * 0.8)` = 200ms, matching PANEL_EXIT_MS.
    expect(assistantCss).toContain('calc(var(--duration-base) * 0.8)');
    expect(assistantCss).toContain('.ai-panel.closing');
  });

  it('settles the panel sections staggered on open only', () => {
    // The class sits on the panel root, which mounts fresh on every open
    // (conditional render on `mounted`), so a message render cannot replay it.
    expect(assistantSource).toContain("cn('ai-panel', 'settle', closing && 'closing')");
    // The chat body staggers its own sections (notice, log, composer).
    expect(assistantSource).toContain('ai-panel-body settle');
  });
});

describe('splitter rubber band', () => {
  it('passes raw values inside the bounds through unchanged', () => {
    expect(resistSplit(20)).toBe(20);
    expect(resistSplit(42)).toBe(42);
    expect(resistSplit(78)).toBe(78);
  });

  it('shows only 15% of the overshoot past either bound', () => {
    expect(resistSplit(88)).toBeCloseTo(79.5); // 78 + 10 × 0.15
    expect(resistSplit(10)).toBeCloseTo(18.5); // 20 − 10 × 0.15
  });

  it('fences the raw percentage to 0–100 before resisting', () => {
    expect(resistSplit(-40)).toBeCloseTo(17); // 20 − 20 × 0.15
    expect(resistSplit(150)).toBeCloseTo(81.3); // 78 + 22 × 0.15
  });

  it('follows the pointer while dragging and settles only on release', () => {
    const source = readFileSync(new URL('../src/pages/WorkspacePage.tsx', import.meta.url), 'utf8');
    // The displayed split is the rubber-banded drag value, not the clamped
    // store one; `.settling` animates only the release snap back.
    expect(source).toContain('const displayPct = dragPct ?? editorPct');
    expect(source).toContain("splitSettling && 'settling'");
    expect(source).toContain('const SPLIT_SETTLE_MS = 200');
    expect(source).toContain('clearTimeout(timer)');
    // resistSplit is used on the pointer-move path only — keyboard resizing
    // goes through the store clamp, never through the band.
    expect(countOccurrences(source, 'resistSplit(')).toBe(2); // definition + move
  });

  it('animates the snap back with an ease-in-out and none while dragging', () => {
    const css = readFileSync(new URL('../src/styles/features/editor.css', import.meta.url), 'utf8');
    const wrapBlock = css.match(/\.editor-wrap \{[\s\S]*?\n\}/)?.[0] ?? '';
    // Direct follow: the base rule carries no height transition.
    expect(wrapBlock).not.toContain('transition');
    // The snap back is an on-screen movement: ease-in-out, 200ms.
    const settling = css.match(/\.editor-wrap\.settling \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(settling).toContain('transition: height 0.2s var(--ease-in-out)');
  });
});

describe('format options motion', () => {
  it('pops from its trigger corner with a kept-mounted exit', () => {
    const source = readFileSync(new URL('../src/pages/WorkspacePage.tsx', import.meta.url), 'utf8');
    // Opens from the caret at the right of the Format split-button.
    expect(source).toContain("'--pop-origin': 'top right'");
    expect(source).toContain("formatMenuOpen && 'pop-in'");
    expect(source).toContain("formatMenuClosing && 'pop-out opacity-0'");
    // The menu stays mounted through the pop-out (120ms, `--duration-exit`)
    // before `hidden` returns.
    expect(source).toContain('const FORMAT_MENU_EXIT_MS = 130');
    expect(source).toContain('hidden={!formatMenuOpen && !formatMenuClosing}');
  });
});
