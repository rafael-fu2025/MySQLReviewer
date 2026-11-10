import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PracticeEmptyScreen } from '../src/pages/PracticePage';
import type {
  PracticeDaily,
  PracticeProgressPublic,
  PracticeReviewQueueItem,
  PracticeSetPublic,
} from '../shared/types';

/**
 * D-15, D-16 — the SQL Lab empty state.
 *
 * The page reads the app store, so the empty screen is rendered as a
 * presentational component with plain props.
 */

function renderEmptyScreen(
  overrides: {
    progress?: PracticeProgressPublic | null;
    daily?: PracticeDaily | null;
    dailyLoading?: boolean;
    dailyFailed?: boolean;
    reviewItems?: PracticeReviewQueueItem[];
    hubLoading?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <PracticeEmptyScreen
      database="northwind"
      error={null}
      recentSets={[] as PracticeSetPublic[]}
      onPick={() => {}}
      onGenerate={() => {}}
      progress={overrides.progress ?? null}
      onRefreshProgress={() => {}}
      onClearAttempts={() => {}}
      daily={overrides.daily ?? null}
      dailyLoading={overrides.dailyLoading ?? false}
      dailyFailed={overrides.dailyFailed ?? false}
      onOpenDaily={() => {}}
      onRetryDaily={() => {}}
      reviewItems={overrides.reviewItems ?? []}
      reviewBusyKey={null}
      onStartReview={() => {}}
      onDismissReview={() => {}}
      hubLoading={overrides.hubLoading ?? false}
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
    expect(buttonClass(html, 'Generate challenges')).toContain('button-primary');
  });

  it('does not promise a step the empty screen cannot perform', () => {
    const html = renderEmptyScreen();
    // There is no tables or topics picker on this screen: the copy has to
    // point at the setup panel instead of at a step the user cannot take.
    expect(html).not.toContain('Choose tables and topics');
    expect(html).toContain('setup');
  });
});

describe('SQL Lab hub learning loop', () => {
  it('hosts the progress, daily and review sections on the hub', () => {
    const html = renderEmptyScreen();
    expect(html).toContain('Daily challenge');
    expect(html).toContain('Review due today (0)');
    expect(html).toContain('Attempt stats appear after you submit answers.');
  });
});

describe('SQL Lab hub loading state (D2)', () => {
  it('renders skeletons on the hub cards while the first fetch is in flight', () => {
    const html = renderEmptyScreen({ hubLoading: true });
    // 3 stat-sized blocks (progress) + 2 review rows + 2 recent sets.
    expect(html.split('class="skeleton"').length - 1).toBe(7);
  });

  it('does not show the empty-state copy while loading', () => {
    const html = renderEmptyScreen({ hubLoading: true });
    // Loading is not empty: the quiet copies wait for the data.
    expect(html).not.toContain('Attempt stats appear after you submit answers.');
    expect(html).not.toContain('Nothing to review right now');
    expect(html).not.toContain('Start review</button>');
  });

  it('shows the empty states once the hub has resolved', () => {
    const html = renderEmptyScreen({ hubLoading: false });
    expect(html).not.toContain('class="skeleton"');
    expect(html).toContain('Review due today (0)');
    expect(html).toContain('Attempt stats appear after you submit answers.');
    // An empty recent list stays silent: the card is not rendered at all.
    expect(html).not.toContain('Recent challenge sets');
  });
});

/**
 * M3 — content-level motion. Swapping the active question (tracker, arrows,
 * j/k shortcuts, the daily card, the review queue) crossfades through the
 * View Transitions API when the browser has it and stays a plain state
 * update when it does not.
 */
describe('M3 motion wiring', () => {
  const source = readFileSync(new URL('../src/pages/PracticePage.tsx', import.meta.url), 'utf8');

  it('navigating questions rides the View Transitions API with a plain fallback', () => {
    expect(source).toContain('function withQuestionTransition');
    expect(source).toContain('document.startViewTransition');
    // Feature-detected: the React 19 pattern flushes the state change inside
    // the transition callback; without the API the update runs directly.
    expect(source).toMatch(
      /startViewTransition[\s\S]*?flushSync\(update\)[\s\S]*?\}\s*update\(\);/,
    );
  });
});
