import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PracticeDailyCard,
  PracticeProgressCard,
  QuestionHints,
  ReviewQueueCard,
  formatElapsedTime,
  hintLadderTiers,
  isTypingTarget,
} from '../src/pages/PracticePage';
import type {
  PracticeDaily,
  PracticeProgressPublic,
  PracticeQuestionPublic,
  PracticeReviewQueueItem,
} from '../shared/types';

/**
 * Work package 8 — the learning-loop UI on the SQL Lab hub and in the
 * challenge view.
 *
 * The page reads the app store, so every piece is rendered as a
 * presentational component with plain props; the wiring that lives inside
 * `PracticePage` (timer reset, attempt counting, key bindings) is pinned by
 * source assertions, the same pattern the workspace tests use.
 */

const progress: PracticeProgressPublic = {
  totalAttempts: 12,
  averageScore: 74,
  topics: [
    { topic: 'joins', attempts: 5, averageScore: 88, bestScore: 95 },
    { topic: 'aggregation', attempts: 4, averageScore: 52, bestScore: 70 },
    { topic: 'select', attempts: 3, averageScore: 0, bestScore: 40 },
    { topic: 'indexes', attempts: 0, averageScore: 0, bestScore: 0 },
  ],
  recent: [],
  recommendedTopics: ['aggregation', 'select'],
  currentStreak: 3,
  longestStreak: 7,
  xp: 420,
};

const question: PracticeQuestionPublic = {
  id: 'q1',
  type: 'write-query',
  title: 'Top customers by revenue',
  scenario: 'Rank the customers by their total order value.',
  difficulty: 'medium',
  topics: ['joins', 'aggregation'],
  schemaTables: ['customers', 'orders'],
  orderMatters: false,
  hints: ['Start from the orders table', 'GROUP BY the customer id'],
  hintLadder: {
    nudge: 'Which clause turns many rows into one per customer?',
    approach: 'Join customers to orders, aggregate per customer, then order.',
    skeleton: 'SELECT c.name, SUM(o.total)\nFROM ...\nGROUP BY ...',
  },
  estimatedMinutes: 5,
  execute: true,
};

const flatQuestion: PracticeQuestionPublic = {
  ...question,
  id: 'q2',
  hintLadder: undefined,
};

const reviewItems: PracticeReviewQueueItem[] = [
  {
    setId: 'set-1',
    questionId: 'q1',
    title: 'Monthly revenue rollup',
    scenario: 'Aggregate the order table per month.',
    topics: ['aggregation'],
    difficulty: 'hard',
    box: 2,
    dueAt: '2026-11-07T00:00:00Z',
    lastVerdict: 'close',
    lastAttemptAt: '2026-11-04T00:00:00Z',
  },
  {
    setId: 'set-2',
    questionId: 'q9',
    title: 'Duplicate email finder',
    scenario: 'Find customers that share an email.',
    topics: ['select', 'joins'],
    difficulty: 'easy',
    box: 0,
    dueAt: '2026-11-01T00:00:00Z',
    lastVerdict: 'incorrect',
    lastAttemptAt: '2026-10-28T00:00:00Z',
  },
];

const daily: PracticeDaily = {
  date: '2026-11-08',
  set: {
    id: 'set-daily',
    profileId: 'p1',
    createdAt: '2026-11-08T09:00:00.000Z',
    database: 'northwind',
    providerId: 'prov-1',
    model: 'test-model',
    summary: 'One challenge to keep the streak alive.',
    questions: [question],
  },
};

function renderProgressCard(value: PracticeProgressPublic | null, loading = false): string {
  return renderToStaticMarkup(
    <PracticeProgressCard
      progress={value}
      onRefresh={() => {}}
      onClear={() => {}}
      loading={loading}
    />,
  );
}

function renderDailyCard(value: PracticeDaily | null, loading = false, failed = false): string {
  return renderToStaticMarkup(
    <PracticeDailyCard
      daily={value}
      loading={loading}
      failed={failed}
      onOpen={() => {}}
      onRetry={() => {}}
    />,
  );
}

function renderReviewQueue(
  items: PracticeReviewQueueItem[],
  busyKey: string | null = null,
  loading = false,
): string {
  return renderToStaticMarkup(
    <ReviewQueueCard
      items={items}
      busyKey={busyKey}
      onStart={() => {}}
      onDismiss={() => {}}
      loading={loading}
    />,
  );
}

/** The class list of the first button that carries the given label. */
function buttonClass(html: string, label: string): string {
  const index = html.indexOf(`${label}</button>`);
  expect(index).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<button', index);
  const classIndex = html.indexOf('class="', start);
  const end = html.indexOf('"', classIndex + 7);
  return html.slice(classIndex + 7, end);
}

function renderHints(current: PracticeQuestionPublic, shown: number): string {
  return renderToStaticMarkup(
    <QuestionHints question={current} shown={shown} onReveal={() => {}} />,
  );
}

describe('hub dashboard card', () => {
  it('renders current streak, longest streak and XP when progress exists', () => {
    const html = renderProgressCard(progress);
    expect(html).toContain('Current streak');
    expect(html).toContain('Longest streak');
    expect(html).toContain('XP');
    // The values sit in the keyed num-pop wrapper inside .stat-value (D2).
    expect(html).toContain('>3</span>');
    expect(html).toContain('>7</span>');
    expect(html).toContain('>420</span>');
  });

  it('shows a lit flame while the streak is alive and a burnt-out one at zero', () => {
    expect(renderProgressCard(progress)).toContain('lucide-flame');
    expect(renderProgressCard(progress)).not.toContain('lucide-flame-kindling');
    const cold = renderProgressCard({ ...progress, currentStreak: 0 });
    expect(cold).toContain('lucide-flame-kindling');
  });

  it('differentiates the longest streak with a calendar icon (D2)', () => {
    const html = renderProgressCard(progress);
    expect(html).toContain('lucide-calendar-days');
    // The longest-streak slot no longer repeats the current streak's flame.
    expect(html.split('lucide-flame"').length - 1).toBe(1);
  });

  it('keys the stat values so the pop animation replays on change (D2)', () => {
    const html = renderProgressCard(progress);
    expect(html.split('stat-value num-pop').length - 1).toBe(3);
  });

  it('shows stat-sized skeletons while the hub fetch is in flight (D2)', () => {
    const html = renderProgressCard(null, true);
    expect(html.split('class="skeleton"').length - 1).toBe(3);
    // Loading is not empty: the quiet copy waits for the data.
    expect(html).not.toContain('Attempt stats appear after you submit answers.');
    expect(renderProgressCard(null, false)).toContain(
      'Attempt stats appear after you submit answers.',
    );
  });

  it('keeps the recommended topics line and the per-topic score bars', () => {
    const html = renderProgressCard(progress);
    expect(html).toContain('Recommended next');
    expect(html).toContain('Aggregation · SELECT &amp; filtering');
    // Topic bars carry the "avg · attempts" mono label of each topic.
    expect(html).toContain('88 · 5×');
    expect(html).toContain('Joins');
    // Topics without attempts are not listed.
    expect(html).not.toContain('Indexes');
  });

  it('stays quiet before the first attempt', () => {
    const html = renderProgressCard(null);
    expect(html).toContain('Attempt stats appear after you submit answers.');
    expect(html).not.toContain('Current streak');
  });
});

describe('daily challenge card', () => {
  it('announces the preparation while the challenge is generated', () => {
    const html = renderDailyCard(null, true, false);
    expect(html).toContain('Preparing today');
  });

  it('explains the no-provider day in plain words', () => {
    const html = renderDailyCard({ date: '2026-11-08', set: null, reason: 'no-provider' });
    expect(html).toContain('No AI provider is configured');
  });

  it('explains a failed generation and offers another try', () => {
    const html = renderDailyCard({ date: '2026-11-08', set: null, reason: 'generation-failed' });
    expect(html).toContain('could not be generated');
    expect(html).toContain('Try again</button>');
  });

  it('shows the date, the challenge preview and the open action', () => {
    const html = renderDailyCard(daily);
    expect(html).toContain('2026-11-08');
    expect(html).toContain('Top customers by revenue');
    expect(html).toContain('Rank the customers by their total order value.');
    // Filler topic chips are gone (D2); the difficulty badge stays.
    expect(html).not.toContain('Joins');
    expect(html).not.toContain('badge">Aggregation');
    expect(html).toContain('badge badge-ember');
    expect(html).toContain('medium');
    expect(html).toContain('Open challenge</button>');
  });

  it('makes "Open challenge" the primary action of the daily card (D2)', () => {
    const html = renderDailyCard(daily);
    expect(buttonClass(html, 'Open challenge')).toContain('button-primary');
  });

  it('offers a retry when the daily request itself failed', () => {
    const html = renderDailyCard(null, false, true);
    expect(html).toContain('could not be loaded');
    expect(html).toContain('Retry</button>');
  });
});

describe('review queue', () => {
  it('lists due items with difficulty, box and plain-text topics', () => {
    const html = renderReviewQueue(reviewItems);
    expect(html).toContain('Review due today (2)');
    expect(html).toContain('Monthly revenue rollup');
    expect(html).toContain('Duplicate email finder');
    // SM-2 boxes display one-based: box 2 renders as 3, box 0 as 1.
    expect(html).toContain('Box 3');
    expect(html).toContain('Box 1');
    // The last verdict and its date are filler (D2): neither renders anymore.
    expect(html).not.toContain('>close</span>');
    expect(html).not.toContain('>incorrect</span>');
    expect(html).not.toContain('last 2026-11-04');
    // Topics are plain inline muted text, not badge chips.
    expect(html).toContain('Aggregation');
    expect(html).toContain('SELECT &amp; filtering · Joins');
    expect(html).not.toContain('badge">Aggregation');
    // Rows carry the stagger class and keep their boxed look.
    expect(html.split('review-row flex items-start').length - 1).toBe(2);
  });

  it('gives every item its own start and dismiss actions, with start as primary (D2)', () => {
    const html = renderReviewQueue(reviewItems);
    expect(html.split('Start review</button>').length - 1).toBe(2);
    expect(html.split('Dismiss this review item').length - 1).toBe(2);
    expect(buttonClass(html, 'Start review')).toContain('button-primary');
  });

  it('shows an empty state when nothing is due', () => {
    const html = renderReviewQueue([]);
    expect(html).toContain('Review due today (0)');
    expect(html).toContain('Nothing to review right now');
    expect(html).not.toContain('Start review</button>');
  });

  it('shows row skeletons while the review fetch is in flight (D2)', () => {
    const html = renderReviewQueue([], null, true);
    expect(html.split('class="skeleton"').length - 1).toBe(2);
    // Loading is not empty: the quiet copy waits for the data.
    expect(html).not.toContain('Nothing to review right now');
    expect(html).not.toContain('Start review</button>');
    const settled = renderReviewQueue([], null, false);
    expect(settled).not.toContain('class="skeleton"');
    expect(settled).toContain('Nothing to review right now');
  });
});

describe('hint ladder', () => {
  it('reveals the tiers strictly in order, one per state', () => {
    const closed = renderHints(question, 0);
    expect(closed).toContain('Show the nudge</button>');
    expect(closed).not.toContain('Which clause turns many rows into one per customer?');

    const nudged = renderHints(question, 1);
    expect(nudged).toContain('Which clause turns many rows into one per customer?');
    expect(nudged).toContain('Show the approach</button>');
    expect(nudged).not.toContain('Join customers to orders');

    const approached = renderHints(question, 2);
    expect(approached).toContain('Join customers to orders, aggregate per customer');
    expect(approached).toContain('Show the skeleton</button>');
  });

  it('renders the skeleton tier as code once fully revealed', () => {
    const html = renderHints(question, 3);
    expect(html).toContain('All tiers revealed');
    expect(html).toContain('code-block');
    expect(html).toContain('SUM(o.total)');
    expect(html).toContain('disabled');
  });

  it('keeps the order when the model skipped a tier', () => {
    const ladder = hintLadderTiers({ nudge: 'Look at GROUP BY', skeleton: 'SELECT ...' });
    expect(ladder.map((tier) => tier.label)).toEqual(['Nudge', 'Skeleton']);
  });

  it('falls back to the flat hint list for questions without a ladder', () => {
    const html = renderHints(flatQuestion, 0);
    expect(html).toContain('Show a hint</button>');
    expect(html).not.toContain('Show the nudge');
    const revealed = renderHints(flatQuestion, 1);
    expect(revealed).toContain('Start from the orders table');
    expect(revealed).toContain('Another hint</button>');
  });

  it('prefers the ladder over the flat union when both exist', () => {
    const html = renderHints(question, 0);
    expect(html).toContain('Show the nudge</button>');
    expect(html).not.toContain('Show a hint</button>');
  });

  it('renders nothing for a question without any hints', () => {
    expect(renderHints({ ...flatQuestion, hints: [] }, 0)).toBe('');
  });
});

describe('per-question timer', () => {
  it('formats wall-clock time as mm:ss', () => {
    expect(formatElapsedTime(0)).toBe('00:00');
    expect(formatElapsedTime(59_400)).toBe('00:59');
    expect(formatElapsedTime(65_000)).toBe('01:05');
    expect(formatElapsedTime(3_600_000)).toBe('60:00');
    // A tick that lands before the reset never renders negative time.
    expect(formatElapsedTime(-4_000)).toBe('00:00');
  });

  it('resets with the active question and ticks once a second while a set is open', () => {
    const source = readFileSync(new URL('../src/pages/PracticePage.tsx', import.meta.url), 'utf8');
    // The stopwatch restarts in every handler that moves the active question:
    // set activation, a navigation jump and a review jump.
    const resets = source.split('setQuestionOpenedAt(Date.now())').length - 1;
    expect(resets).toBe(3);
    expect(source).toContain('Every jump to another question restarts its stopwatch');
    // The display ticks once a second while a challenge is open.
    expect(source).toContain('window.setInterval(() => setElapsedTick(Date.now()), 1_000)');
    // The labels live in the challenge header.
    expect(source).toContain('formatElapsedTime(elapsedMs)');
    expect(source).toContain('Attempt {attemptNumber}');
  });

  it('counts attempts from the recorded attempts plus one', () => {
    const source = readFileSync(new URL('../src/pages/PracticePage.tsx', import.meta.url), 'utf8');
    // Seeded from the set's attempt history…
    expect(source).toContain('counts[attempt.questionId] = (counts[attempt.questionId] ?? 0) + 1');
    // …bumped after a newly graded submission (a duplicate never counts)…
    expect(source).toMatch(/\[question\.id\]: \(previous\[question\.id\] \?\? 0\) \+ 1/);
    // …and cleared when another set is activated.
    expect(source).toContain('setAttemptCounts({})');
  });
});

describe('keyboard flow', () => {
  it('treats fields, contenteditable nodes and CodeMirror as typing surfaces', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
    expect(isTypingTarget({ tagName: 'div' })).toBe(false);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'select' })).toBe(true);
    expect(isTypingTarget({ isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ closest: () => null })).toBe(false);
    // CodeMirror hosts the caret in a contenteditable tree under `.cm-editor`.
    expect(
      isTypingTarget({ closest: (selector: string) => (selector === '.cm-editor' ? {} : null) }),
    ).toBe(true);
  });

  it('binds navigation and the Alt chords without touching existing bindings', () => {
    const source = readFileSync(new URL('../src/pages/PracticePage.tsx', import.meta.url), 'utf8');
    // J/K and the arrows navigate; plain keys yield to typing surfaces.
    expect(source).toContain("event.key === 'ArrowDown'");
    expect(source).toContain("event.key === 'ArrowUp'");
    expect(source).toContain('isTypingTarget(event.target)');
    // The chords match on the physical key (macOS folds Option+S/H into
    // other characters, the same reason the workspace uses `code` for Alt+T).
    expect(source).toContain("event.code === 'KeyS'");
    expect(source).toContain("event.code === 'KeyH'");
    expect(source).not.toContain("event.key.toLowerCase() === 's'");
    // Ctrl+B (schema panel) and Ctrl+Enter (preview run, inside the editor)
    // keep their own bindings; the flow never claims them.
    expect(source).toContain("event.key.toLowerCase() === 'b'");
    expect(source).toContain('Alt+S submits');
  });
});

describe('learning-loop api client', () => {
  const source = readFileSync(new URL('../src/lib/db-api.ts', import.meta.url), 'utf8');

  it('follows the dbApi patterns for the three new endpoints', () => {
    expect(source).toContain('practiceReviewQueue(profileId: string)');
    expect(source).toContain('`/api/practice/review?profileId=${encodeURIComponent(profileId)}`');
    expect(source).toContain('dismissPracticeReviewItem(');
    expect(source).toContain(
      '/api/practice/review/${encodeURIComponent(setId)}/${encodeURIComponent(questionId)}',
    );
    expect(source).toContain('practiceDaily(profileId: string)');
    expect(source).toContain('`/api/practice/daily?profileId=${encodeURIComponent(profileId)}`');
  });
});

/**
 * D2 — the practice design pass. The page reads the app store, so the wiring
 * that only exists inside `PracticePage` is pinned by source assertions, and
 * the motion tokens live in practice.css.
 */
describe('D2 design pass wiring', () => {
  const source = readFileSync(new URL('../src/pages/PracticePage.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/features/practice.css', import.meta.url), 'utf8');

  it('drops the redundant hints and labels', () => {
    // The tooltip carries the shortcut; the button label does not repeat it.
    expect(source).not.toContain('<Kbd>');
    // The 20-table cap lives in the placeholder only.
    expect(source).toContain('Leave empty to auto-select.');
    expect(source).not.toContain('Leave empty to use up to 20 tables');
    // The model field keeps its label; the placeholder echo is gone.
    expect(source).not.toContain('placeholder="model"');
    // The page-level error note yields to the modal callout while setup is open.
    expect(source).toContain('error && !setupOpen');
    // Row count and duration live in the grid toolbar; the summary is a label.
    expect(source).toContain('Query result');
    expect(source).not.toContain('Query result ·');
  });

  it('no longer toasts the verdict', () => {
    expect(source).not.toContain("'Correct.'");
    // toast is still used elsewhere on the page.
    expect(source).toContain('const toast = useAppStore((state) => state.toast);');
  });

  it('animates the useful feedback', () => {
    // Topic bar fill transitions its inline width. M3 moved the bars to the
    // in-out ease: a width change of a persistent element is on-screen
    // movement, which eases in-out per the motion conventions.
    expect(source).toContain('topic-bar-fill');
    expect(css).toContain('.topic-bar-fill');
    expect(css).toContain('transition: width var(--duration-base) var(--ease-in-out)');
    // Evaluation card entrance.
    expect(css).toContain('.card-enter');
    expect(source).toContain('"p-4 card-enter"');
    // Review rows stagger in, capped at five rows.
    expect(css).toContain('.review-row:nth-child(5)');
    expect(css).toContain('animation-delay: 0.15s');
    // Stat values pop on change.
    expect(css).toContain('@keyframes num-pop');
    expect(css).toContain('.stat-value.num-pop');
    expect(source).toContain('stat-value num-pop');
  });

  it('uses tabular numerals on the counters', () => {
    expect(source).toContain('num flex items-center gap-1 font-mono text-2xs text-muted');
    expect(source).toContain('"num text-2xs text-muted"');
    expect(source).toContain('"section-title num"');
    expect(css).toContain('font-variant-numeric: tabular-nums;');
  });

  it('enlarges the answer surface', () => {
    expect(source.split('min-h-[380px]').length - 1).toBe(2);
    expect(source).not.toContain('min-h-[280px]');
  });

  it('follows the nested radius rule', () => {
    // The navigator and its boxes use the shared tokens…
    expect(css).toMatch(/\.practice-nav \{[^}]*border-radius: var\(--radius-md\)/);
    expect(css).toMatch(/\.practice-nav-box \{[^}]*border-radius: var\(--radius-xs\)/);
    // …and the old pixel radii are gone from both.
    expect(css).not.toContain('border-radius: 13px');
    // Review rows and recent-set rows follow the same rule.
    expect(css).toMatch(/\.review-row \{[^}]*border-radius: var\(--radius-xs\)/);
    expect(css).toMatch(/\.recent-set-row \{[^}]*border-radius: var\(--radius-xs\)/);
    // The score-explainer summary pill is a control, not a boxed surface, so
    // it keeps its own radius.
    expect(css).toContain('border-radius: 6px');
  });

  it('fills the flagged badge like the navigator flag', () => {
    expect(source).toMatch(/<Flag size=\{9\} fill="currentColor"/);
  });

  it('loads the hub through one Promise.all pass that settles the loading flag', () => {
    expect(source).toContain('const [hubLoading, setHubLoading] = useState(true)');
    expect(source).toContain('setHubLoading(false)');
    expect(source).toMatch(/Promise\.all\(\[\s*dbApi\.practiceProgress/);
  });
});

/**
 * M3 — content-level motion. Question swaps crossfade through the View
 * Transitions API (root only — the content is never the same element twice),
 * a correct verdict pulses the badge ring once, and the remaining practice
 * lists pick up the 30ms row stagger the review rows established in D2.
 */
describe('M3 motion wiring', () => {
  const source = readFileSync(new URL('../src/pages/PracticePage.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/features/practice.css', import.meta.url), 'utf8');
  const findingsCss = readFileSync(
    new URL('../src/styles/features/findings.css', import.meta.url),
    'utf8',
  );
  const modalCss = readFileSync(
    new URL('../src/styles/components/modal-toast.css', import.meta.url),
    'utf8',
  );
  const modals = readFileSync(
    new URL('../src/components/WorkspaceModals.tsx', import.meta.url),
    'utf8',
  );

  it('crossfades question navigation through the View Transitions API', () => {
    expect(source).toContain('function withQuestionTransition');
    expect(source).toContain('document.startViewTransition');
    // The React 19 pattern: the state change is flushed synchronously inside
    // the transition callback.
    expect(source).toContain('flushSync(update)');
    // Every navigation entry point rides the same path: the tracker, the
    // prev/next arrows and the j/k shortcuts (goTo), the daily card, and the
    // review queue.
    expect(source).toContain('withQuestionTransition(() => {');
    expect(source).toContain('withQuestionTransition(() => activateSet(daily.set))');
    // Different content on both sides — no shared element name, so the root
    // crossfade is all there is.
    expect(source).not.toContain('view-transition-name');
  });

  it('pulses the verdict badge only on a fresh correct evaluation', () => {
    expect(source).toContain('const [verdictPulse, setVerdictPulse] = useState(false)');
    expect(source).toContain("if (result.verdict === 'correct') setVerdictPulse(true)");
    // The flag resets with the active question (the same render-time
    // adjustment that clears hints, so grades restored from earlier attempts
    // never replay it) and clears on a timer afterwards.
    expect(source).toMatch(/setRunError\(null\);\s*setVerdictPulse\(false\);/);
    expect(source).toContain('VERDICT_PULSE_MS');
    // The shared Badge stays untouched — the wrapper span carries the class.
    expect(source).toMatch(/className=\{cn\(verdictPulse && 'pulse-success'\)\}/);
  });

  it('staggers the recent-set rows like the review rows', () => {
    expect(css).toMatch(
      /\.recent-set-row \{[^}]*animation: fadeUp var\(--duration-base\) var\(--ease-out\) both/,
    );
    expect(css).toContain('.recent-set-row:nth-child(5)');
    expect(css).toContain('animation-delay: 0.15s');
  });

  it('staggers the history and snippet rows inside their modals', () => {
    expect(modalCss).toContain('.history-row');
    expect(modalCss).toContain('.snippet-row');
    expect(modalCss).toContain('animation-delay: 0.15s');
    expect(modals).toContain('history-row');
    expect(modals).toContain('snippet-row');
  });

  it('staggers the findings list, capped at eight rows', () => {
    expect(findingsCss).toMatch(/\.finding \{[^}]*animation: fadeUp/);
    expect(findingsCss).toContain('.finding:nth-child(8)');
    expect(findingsCss).toContain('animation-delay: 0.24s');
  });
});
