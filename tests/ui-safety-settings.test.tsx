import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS } from '@shared/types';
import { SafetyTab, SettingsHeader } from '../src/pages/SettingsPage';
import type { NumericField, SafetyTabProps } from '../src/pages/SettingsPage';

/**
 * The markup of the `<div>` that encloses `index`.
 *
 * `renderToStaticMarkup` emits plain, well-nested markup, so counting the div
 * tags is enough to find the element around a piece of text.
 */
function enclosingDiv(html: string, index: number): string {
  const open: number[] = [];
  const tags = /<(\/?)div\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    if (match.index > index) break;
    if (match[1] === '/') open.pop();
    else open.push(match.index);
  }
  const start = open[open.length - 1];
  if (start === undefined) throw new Error('the marker is not inside a div');
  let depth = 0;
  const rest = html.slice(start);
  const scan = /<(\/?)div\b[^>]*>/g;
  while ((match = scan.exec(rest)) !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return rest.slice(0, match.index + match[0].length);
  }
  throw new Error('unbalanced markup');
}

/** The markup of the `.card` element that holds `text`. */
function cardAround(html: string, text: string): string {
  const at = html.indexOf(text);
  if (at < 0) throw new Error(`"${text}" is not in the markup`);
  const start = html.lastIndexOf('<div class="card', at);
  if (start < 0) throw new Error(`no card holds "${text}"`);
  let depth = 0;
  const rest = html.slice(start);
  const tags = /<(\/?)div\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(rest)) !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return rest.slice(0, match.index + match[0].length);
  }
  throw new Error('unbalanced markup');
}

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const NUMERIC_DRAFTS: Record<NumericField, string> = {
  rowLimit: '1000',
  queryTimeoutMs: '30000',
  cellMaxChars: '16384',
  aiContextChars: '24000',
  historyLimit: '500',
};

function safetyProps(overrides: Partial<SafetyTabProps> = {}): SafetyTabProps {
  return {
    writeUnlockEnabled: true,
    writeUnlockBusy: false,
    savingSettings: false,
    draft: { ...DEFAULT_SETTINGS },
    numericDrafts: NUMERIC_DRAFTS,
    numericErrors: {},
    onToggleWriteUnlock: () => {},
    onToggleMaskSensitive: () => {},
    onToggleAgentTool: () => {},
    mcpServersJson: '[]',
    mcpError: null,
    onMcpServersChange: () => {},
    onMcpServersApply: () => {},
    onNumericChange: () => {},
    onNumericBlur: () => {},
    onSave: () => {},
    ...overrides,
  };
}

describe('Settings → Safety action row', () => {
  it('keeps the save button out of the Query Limits card', () => {
    const html = renderToStaticMarkup(<SafetyTab {...safetyProps()} />);

    expect(occurrences(html, 'Save safety settings')).toBe(1);
    // The button saves the whole tab — write unlocking, masking and the query
    // limits — so it must not sit inside the QUERY LIMITS card, where its
    // placement implied it belonged to the four limit fields.
    expect(cardAround(html, 'Query limits')).not.toContain('Save safety settings');
  });

  it('puts the save button in a right-aligned action row below the last card', () => {
    const html = renderToStaticMarkup(<SafetyTab {...safetyProps()} />);
    const buttonAt = html.indexOf('Save safety settings');
    expect(buttonAt).toBeGreaterThan(html.indexOf('Query limits'));

    const actionRow = enclosingDiv(html, buttonAt);
    expect(actionRow).toContain('justify-end');
    // A rule above the row keeps it visually apart from the card above it.
    expect(actionRow).toContain('border-t');
  });
});

describe('Settings sticky header', () => {
  it('keeps the heading and the section switcher reachable while the page scrolls', () => {
    const html = renderToStaticMarkup(
      <SettingsHeader tab="safety" profileCount={2} providerCount={1} onTabChange={() => {}} />,
    );

    const stickyAt = html.indexOf('sticky top-0');
    expect(stickyAt).toBeGreaterThan(-1);

    const header = enclosingDiv(html, stickyAt);
    expect(header).toContain('Settings'); // the page heading
    expect(header).toContain('role="tablist"'); // the section switcher
    expect(header).toContain('Safety'); // one of its tabs
  });
});
