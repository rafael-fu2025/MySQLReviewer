import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PracticeEmptyScreen } from '../src/pages/PracticePage';
import type { PracticeSetPublic } from '../shared/types';

/**
 * D-15, D-16 — the SQL Lab empty state.
 *
 * The page reads the app store, so the empty screen is rendered as a
 * presentational component with plain props.
 */

function renderEmptyScreen(): string {
  return renderToStaticMarkup(
    <PracticeEmptyScreen
      database="northwind"
      error={null}
      recentSets={[] as PracticeSetPublic[]}
      onPick={() => {}}
      onGenerate={() => {}}
    />,
  );
}

/** The class list of the button that carries the given label. */
function buttonClass(html: string, label: string): string {
  const index = html.indexOf(`${label}</button>`);
  expect(index).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<button', index);
  const classIndex = html.indexOf('class="', start);
  const end = html.indexOf('"', classIndex + 7);
  return html.slice(classIndex + 7, end);
}

function occurrences(html: string, text: string): number {
  return html.split(text).length - 1;
}

describe('SQL Lab empty state (D-15)', () => {
  it('keeps the empty state in the space that is left under the header', () => {
    const html = renderEmptyScreen();
    // The empty state is a direct child of the page: the practice stage is
    // not a growing container, so nesting the empty state in it left the
    // block at the top of the viewport with a blank page below.
    expect(html).toContain('empty-anchor');
    expect(html).not.toContain('practice-stage');
    expect(html).not.toContain('practice-main');
  });

  it('keeps the icon, the headline and the description of the empty state', () => {
    const html = renderEmptyScreen();
    expect(html).toContain('No challenge set yet');
    expect(html).toContain('empty-icon');
    expect(html).toContain('empty-copy');
  });
});

describe('SQL Lab empty state actions (D-16)', () => {
  it('offers "Generate challenges" once', () => {
    const html = renderEmptyScreen();
    // Only the buttons count: the page subtitle also names the action.
    expect(occurrences(html, 'Generate challenges</button>')).toBe(1);
  });

  it('keeps the single action as the primary action of the empty state', () => {
    const html = renderEmptyScreen();
    expect(buttonClass(html, 'Generate challenges')).toContain('btn-primary');
  });

  it('does not promise a step the empty screen cannot perform', () => {
    const html = renderEmptyScreen();
    // There is no tables or topics picker on this screen: the copy has to
    // point at the setup panel instead of at a step the user cannot take.
    expect(html).not.toContain('Choose tables and topics');
    expect(html).toContain('setup');
  });
});
