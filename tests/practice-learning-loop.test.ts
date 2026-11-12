import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PracticeAttempt,
  PracticeEvaluation,
  PracticeQuestion,
  PracticeSet,
  PublicUser,
} from '../shared/types';
import { PRACTICE_REVIEW_INTERVAL_DAYS } from '../shared/types';
import { AppError } from '../server/errors';
import { DATA_DIR } from '../server/config';
import {
  addPracticeAttempt,
  getPracticeDailyEntry,
  getPracticeProgress,
  listDuePracticeReviewItems,
  localDateKey,
  practiceStreakStats,
  practiceXpForAttempt,
  recordPracticeReviewOutcome,
  removePracticeReviewItem,
  savePracticeSet,
  setPracticeDailyEntry,
} from '../server/store/practice';
import { filterPracticeHintLadder, toPublicPracticeQuestion } from '../server/db/practice';
import { boundPracticeQuestion } from '../server/ai/practice';

const h = vi.hoisted(() => ({
  resolveProvider: vi.fn(),
  generatePracticeSet: vi.fn(),
}));

vi.mock('../server/store/providers', () => ({
  resolveProvider: h.resolveProvider,
}));

vi.mock('../server/ai/practice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/ai/practice')>();
  return { ...actual, generatePracticeSet: h.generatePracticeSet };
});

import { practiceRouter } from '../server/routes/practice';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const PRACTICE_USER_ID = 'u1';

function dayKey(base: Date, offsetDays: number): string {
  return localDateKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - offsetDays));
}

function question(overrides: Partial<PracticeQuestion> = {}): PracticeQuestion {
  return {
    id: 'q1',
    type: 'write-query',
    title: 'Customers with large orders',
    scenario: 'List the customers who placed an order above 100.',
    difficulty: 'medium',
    topics: ['joins'],
    schemaTables: ['customers', 'orders'],
    brokenSql: null,
    referenceSql: 'SELECT c.id, c.name FROM customers c JOIN orders o ON o.customer_id = c.id',
    expectedResult: 'id | name',
    orderMatters: false,
    hints: [],
    estimatedMinutes: 10,
    execute: true,
    ...overrides,
  };
}

function practiceSet(id: string, profileId: string, questions: PracticeQuestion[]): PracticeSet {
  return {
    id,
    userId: PRACTICE_USER_ID,
    profileId,
    createdAt: '2026-01-01T00:00:00.000Z',
    database: 'shop',
    providerId: 'provider-1',
    model: 'test-model',
    summary: 'One set',
    questions,
  };
}

function attempt(
  id: string,
  profileId: string,
  setId: string,
  questionId: string,
  createdAt: string,
  verdict: PracticeEvaluation['verdict'] = 'correct',
  difficulty: PracticeAttempt['difficulty'] = 'medium',
): PracticeAttempt {
  return {
    id,
    userId: PRACTICE_USER_ID,
    profileId,
    setId,
    questionId,
    database: 'shop',
    topics: ['joins'],
    difficulty,
    userSql: 'SELECT 1',
    userAnswer: '',
    evaluation: {
      questionId,
      executed: true,
      verdict,
      scores: { correctness: 100, performance: 100, style: 100, overall: 100 },
      summary: 'ok',
      strengths: [],
      issues: [],
      nextHint: '',
      comparison: null,
      findings: [],
      explain: null,
      aiFeedback: null,
      referenceSql: 'SELECT 1',
      userSql: 'SELECT 1',
      userAnswer: null,
      userResult: null,
      referenceResult: null,
    },
    createdAt,
  };
}

function iso(date: Date): string {
  return date.toISOString();
}

/** ISO timestamp `days` calendar days after `isoString` (matches the store's due math). */
function isoPlusDays(isoString: string, days: number): string {
  const date = new Date(isoString);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

/** The store document on disk, for asserting the at-rest shape. */
function readStoreFile(): {
  sets: PracticeSet[];
  attempts: PracticeAttempt[];
  reviews?: Record<string, unknown[]>;
  daily?: Record<string, unknown>;
} {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'practice.json'), 'utf8'));
}

function reviewItems(profileId: string, userId = PRACTICE_USER_ID): Array<Record<string, unknown>> {
  const key = `${encodeURIComponent(userId)}:${encodeURIComponent(profileId)}`;
  return (readStoreFile().reviews?.[key] as Array<Record<string, unknown>>) ?? [];
}

/* ------------------------------------------------------------------ */
/* Streaks                                                             */
/* ------------------------------------------------------------------ */

describe('practice streak math', () => {
  const today = new Date(2026, 2, 15, 10, 30, 0); // a fixed local "now"

  it('counts a streak ending today', () => {
    const stats = practiceStreakStats([dayKey(today, 0)], today);
    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(1);
  });

  it('keeps the streak alive when only yesterday has an attempt', () => {
    // The day is not over: yesterday still counts as the live streak.
    const stats = practiceStreakStats([dayKey(today, 1)], today);
    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(1);
  });

  it('counts today and yesterday as a two-day streak', () => {
    const stats = practiceStreakStats([dayKey(today, 0), dayKey(today, 1)], today);
    expect(stats.currentStreak).toBe(2);
    expect(stats.longestStreak).toBe(2);
  });

  it('breaks the current streak at a gap but reports the longest run', () => {
    const stats = practiceStreakStats(
      [dayKey(today, 0), dayKey(today, 1), dayKey(today, 4), dayKey(today, 5), dayKey(today, 6)],
      today,
    );
    expect(stats.currentStreak).toBe(2);
    expect(stats.longestStreak).toBe(3);
  });

  it('returns zero when neither today nor yesterday has an attempt', () => {
    const stats = practiceStreakStats([dayKey(today, 2), dayKey(today, 3)], today);
    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(2);
  });

  it('runs across month boundaries', () => {
    const first = new Date(2026, 2, 1, 9, 0, 0);
    // 2026-02-28 and 2026-03-01 are consecutive days in different months.
    const stats = practiceStreakStats(['2026-02-28', '2026-03-01'], first);
    expect(stats.currentStreak).toBe(2);
    expect(stats.longestStreak).toBe(2);
  });

  it('ignores empty keys from unparsable timestamps', () => {
    const stats = practiceStreakStats(['', dayKey(today, 0)], today);
    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(1);
  });
});

describe('practice xp weights', () => {
  it('pays correct answers 10 × difficulty multiplier', () => {
    expect(practiceXpForAttempt('correct', 'easy')).toBe(10);
    expect(practiceXpForAttempt('correct', 'medium')).toBe(15);
    expect(practiceXpForAttempt('correct', 'hard')).toBe(20);
  });

  it('pays close answers 4 × difficulty multiplier', () => {
    expect(practiceXpForAttempt('close', 'easy')).toBe(4);
    expect(practiceXpForAttempt('close', 'medium')).toBe(6);
    expect(practiceXpForAttempt('close', 'hard')).toBe(8);
  });

  it('pays nothing for incorrect or unexecuted answers', () => {
    expect(practiceXpForAttempt('incorrect', 'medium')).toBe(0);
    expect(practiceXpForAttempt('not-executed', 'hard')).toBe(0);
  });

  it('accumulates streaks and xp over the recorded attempts', async () => {
    const now = new Date();
    const profile = 'profile-progress';
    await addPracticeAttempt(attempt('p1', profile, 'set-p', 'q1', iso(now), 'correct', 'medium'));
    await addPracticeAttempt(
      attempt('p2', profile, 'set-p', 'q2', iso(new Date(now.getTime() - DAY_MS)), 'close', 'hard'),
    );
    await addPracticeAttempt(
      attempt(
        'p3',
        profile,
        'set-p',
        'q3',
        iso(new Date(now.getTime() - 3 * DAY_MS)),
        'correct',
        'easy',
      ),
    );

    const progress = await getPracticeProgress(profile, PRACTICE_USER_ID);
    // today + yesterday are consecutive; three days ago is behind a gap.
    expect(progress.currentStreak).toBe(2);
    expect(progress.longestStreak).toBe(2);
    // 15 (correct/medium) + 8 (close/hard) + 10 (correct/easy)
    expect(progress.xp).toBe(33);
    expect(progress.totalAttempts).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* Spaced repetition                                                   */
/* ------------------------------------------------------------------ */

describe('practice review scheduling', () => {
  it('schedules the intervals [3, 7, 14, 30] and graduates after box 4', async () => {
    const profile = 'profile-srs';
    const setId = 'set-srs';
    const questionId = 'q-srs';
    await savePracticeSet(practiceSet(setId, profile, [question({ id: questionId })]));

    const start = new Date();
    // An incorrect answer lands in box 0, due the next day.
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId,
      verdict: 'incorrect',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(start),
    });
    expect(reviewItems(profile)).toHaveLength(1);
    expect(reviewItems(profile)[0]).toMatchObject({ box: 0, lastVerdict: 'incorrect' });
    expect(reviewItems(profile)[0].dueAt).toBe(isoPlusDays(iso(start), 1));

    // Each correct answer promotes the item: box 1..4 with the ladder intervals.
    let at = start.getTime();
    for (let box = 1; box <= 4; box += 1) {
      at += PRACTICE_REVIEW_INTERVAL_DAYS[box - 1] * DAY_MS;
      await recordPracticeReviewOutcome({
        userId: PRACTICE_USER_ID,
        profileId: profile,
        setId,
        questionId,
        verdict: 'correct',
        topics: ['joins'],
        difficulty: 'medium',
        attemptedAt: iso(new Date(at)),
      });
      expect(reviewItems(profile)).toHaveLength(1);
      expect(reviewItems(profile)[0]).toMatchObject({
        box,
        lastVerdict: 'correct',
        lastAttemptAt: iso(new Date(at)),
      });
      expect(reviewItems(profile)[0].dueAt).toBe(
        isoPlusDays(iso(new Date(at)), PRACTICE_REVIEW_INTERVAL_DAYS[box - 1]),
      );
    }

    // A correct answer at box 4 graduates: the item leaves the queue.
    at += PRACTICE_REVIEW_INTERVAL_DAYS[3] * DAY_MS;
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId,
      verdict: 'correct',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(new Date(at)),
    });
    expect(reviewItems(profile)).toHaveLength(0);
  });

  it('resets to box 0 with a one-day due date on a close verdict', async () => {
    const profile = 'profile-srs-close';
    const setId = 'set-srs-close';
    const questionId = 'q-close';
    await savePracticeSet(practiceSet(setId, profile, [question({ id: questionId })]));
    const start = new Date();
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId,
      verdict: 'correct',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(new Date(start.getTime() - 10 * DAY_MS)),
    });
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId,
      verdict: 'close',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(start),
    });
    expect(reviewItems(profile)[0]).toMatchObject({ box: 0, lastVerdict: 'close' });
    expect(reviewItems(profile)[0].dueAt).toBe(isoPlusDays(iso(start), 1));
  });

  it('never schedules a not-executed verdict', async () => {
    const profile = 'profile-srs-notexec';
    const setId = 'set-srs-notexec';
    await savePracticeSet(practiceSet(setId, profile, [question({ id: 'q-ne' })]));
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId: 'q-ne',
      verdict: 'not-executed',
      topics: ['design'],
      difficulty: 'easy',
      attemptedAt: iso(new Date()),
    });
    expect(reviewItems(profile)).toHaveLength(0);
  });

  it('lists due items with the question text and prunes evicted references', async () => {
    const profile = 'profile-review-store';
    const setId = 'set-review-store';
    const dueQuestion = question({
      id: 'q-due',
      title: 'Due question',
      scenario: 'Find the due rows.',
    });
    const futureQuestion = question({ id: 'q-future', title: 'Future question' });
    await savePracticeSet(practiceSet(setId, profile, [dueQuestion, futureQuestion]));

    const now = new Date();
    // Attempted two days ago with a close verdict: due since yesterday.
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId: 'q-due',
      verdict: 'close',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(new Date(now.getTime() - 2 * DAY_MS)),
    });
    // Attempted just now with a correct verdict: not due for three days.
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId: 'q-future',
      verdict: 'correct',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(now),
    });

    const due = await listDuePracticeReviewItems(PRACTICE_USER_ID, profile);
    expect(due).toHaveLength(1);
    expect(due[0].item.questionId).toBe('q-due');
    expect(due[0].item.box).toBe(0);
    expect(due[0].item.lastVerdict).toBe('close');
    expect(due[0].title).toBe('Due question');
    expect(due[0].scenario).toBe('Find the due rows.');

    // Dismiss removes the item; a second dismiss reports that nothing was left.
    expect(await removePracticeReviewItem(PRACTICE_USER_ID, profile, setId, 'q-due')).toBe(true);
    expect(await listDuePracticeReviewItems(PRACTICE_USER_ID, profile)).toHaveLength(0);
    expect(await removePracticeReviewItem(PRACTICE_USER_ID, profile, setId, 'q-due')).toBe(false);
  });

  it('dismisses only the caller account review item', async () => {
    const profile = 'profile-review-account-dismiss';
    const setIdA = 'set-review-account-a';
    const setIdB = 'set-review-account-b';
    const userB = 'u2';
    await Promise.all([
      savePracticeSet(practiceSet(setIdA, profile, [question({ id: 'q-shared' })])),
      savePracticeSet({
        ...practiceSet(setIdB, profile, [question({ id: 'q-shared' })]),
        userId: userB,
      }),
    ]);
    const attemptedAt = iso(new Date(Date.now() - 2 * DAY_MS));
    await Promise.all([
      recordPracticeReviewOutcome({
        userId: PRACTICE_USER_ID,
        profileId: profile,
        setId: setIdA,
        questionId: 'q-shared',
        verdict: 'close',
        topics: ['joins'],
        difficulty: 'medium',
        attemptedAt,
      }),
      recordPracticeReviewOutcome({
        userId: userB,
        profileId: profile,
        setId: setIdB,
        questionId: 'q-shared',
        verdict: 'close',
        topics: ['joins'],
        difficulty: 'medium',
        attemptedAt,
      }),
    ]);

    expect(await removePracticeReviewItem(PRACTICE_USER_ID, profile, setIdA, 'q-shared')).toBe(
      true,
    );
    expect(await listDuePracticeReviewItems(PRACTICE_USER_ID, profile)).toHaveLength(0);
    expect(await listDuePracticeReviewItems(userB, profile)).toHaveLength(1);
  });

  it('caps the queue per profile and evicts the least recently reviewed', async () => {
    const profile = 'profile-cap';
    const setId = 'set-cap';
    await savePracticeSet(practiceSet(setId, profile, [question({ id: 'q-cap' })]));
    const base = new Date().getTime() - 1_000 * 60 * 60; // an hour ago
    // 502 items at one-minute spacing: the two oldest must be evicted.
    await Promise.all(
      Array.from({ length: 502 }, (_, index) =>
        recordPracticeReviewOutcome({
          userId: PRACTICE_USER_ID,
          profileId: profile,
          setId,
          questionId: `q-${index}`,
          verdict: 'incorrect',
          topics: ['select'],
          difficulty: 'easy',
          attemptedAt: iso(new Date(base + index * 60_000)),
        }),
      ),
    );
    const items = reviewItems(profile);
    expect(items).toHaveLength(500);
    const ids = new Set(items.map((item) => item.questionId));
    expect(ids.has('q-0')).toBe(false);
    expect(ids.has('q-1')).toBe(false);
    expect(ids.has('q-2')).toBe(true);
    expect(ids.has('q-501')).toBe(true);
  }, 120_000);

  it('review retention for A cannot evict B', async () => {
    const profile = 'profile-review-retention-accounts';
    const userB = 'u-review-b';
    const setA = 'set-review-retention-a';
    const setB = 'set-review-retention-b';
    await Promise.all([
      savePracticeSet(practiceSet(setA, profile, [question({ id: 'q-a' })])),
      savePracticeSet({
        ...practiceSet(setB, profile, [question({ id: 'q-b' })]),
        userId: userB,
      }),
    ]);
    const base = Date.now() - 600 * 60_000;
    await recordPracticeReviewOutcome({
      userId: userB,
      profileId: profile,
      setId: setB,
      questionId: 'q-b',
      verdict: 'incorrect',
      topics: ['select'],
      difficulty: 'easy',
      attemptedAt: iso(new Date(base - 60_000)),
    });
    await Promise.all(
      Array.from({ length: 502 }, (_, index) =>
        recordPracticeReviewOutcome({
          userId: PRACTICE_USER_ID,
          profileId: profile,
          setId: setA,
          questionId: `q-a-${index}`,
          verdict: 'incorrect',
          topics: ['select'],
          difficulty: 'easy',
          attemptedAt: iso(new Date(base + index * 60_000)),
        }),
      ),
    );

    expect(reviewItems(profile, PRACTICE_USER_ID)).toHaveLength(500);
    expect(reviewItems(profile, userB).map((item) => item.questionId)).toEqual(['q-b']);
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* Hint ladders                                                        */
/* ------------------------------------------------------------------ */

describe('hint ladder validation', () => {
  it('emits the flat hints as the union of the tiers in order', () => {
    const bounded = boundPracticeQuestion({
      title: 'Top customers',
      scenario: 'List the customers with the highest order totals.',
      hintLadder: {
        nudge: 'Look at the aggregation clause.',
        approach: 'Group the orders by customer and sum the totals.',
        skeleton: 'SELECT … FROM … WHERE …',
      },
      tables: ['customers', 'orders'],
    });
    expect(bounded.hints).toEqual([
      'Look at the aggregation clause.',
      'Group the orders by customer and sum the totals.',
      'SELECT … FROM … WHERE …',
    ]);
    expect(bounded.hintLadder).toEqual({
      nudge: 'Look at the aggregation clause.',
      approach: 'Group the orders by customer and sum the totals.',
      skeleton: 'SELECT … FROM … WHERE …',
    });
  });

  it('drops a tier that trips the leak filter and keeps the others', () => {
    const bounded = boundPracticeQuestion({
      title: 'Top customers',
      scenario: 'List the customers with the highest order totals.',
      hintLadder: {
        nudge: 'Look at the aggregation clause.',
        approach: 'Sum the order totals per customer.',
        skeleton: 'SELECT c.id, c.name FROM customers c JOIN orders o ON o.customer_id = c.id',
      },
      tables: ['customers', 'orders'],
    });
    expect(bounded.hintLadder).toEqual({
      nudge: 'Look at the aggregation clause.',
      approach: 'Sum the order totals per customer.',
    });
    expect(bounded.hints).toEqual([
      'Look at the aggregation clause.',
      'Sum the order totals per customer.',
    ]);
  });

  it('stores nothing when every tier leaks', () => {
    const bounded = boundPracticeQuestion({
      title: 'Top customers',
      scenario: 'List the customers with the highest order totals.',
      hintLadder: {
        nudge: 'SELECT c.id FROM customers c',
        approach: 'INSERT INTO logs VALUES (1)',
        skeleton: 'DELETE FROM orders;',
      },
      tables: ['customers', 'orders'],
    });
    expect(bounded.hintLadder).toBeUndefined();
    expect(bounded.hints).toEqual([]);
  });

  it('applies the storage caps to ladder strings and omits missing tiers', () => {
    const bounded = boundPracticeQuestion({
      title: 'Top customers',
      scenario: 'List the customers with the highest order totals.',
      hintLadder: {
        nudge: `Repeat me. ${'x'.repeat(3_000)}`,
      },
      tables: [],
    });
    expect(bounded.hintLadder?.nudge).toBeDefined();
    expect(bounded.hintLadder?.nudge?.length).toBe(2_001); // 2000 chars + ellipsis
    expect(bounded.hintLadder?.approach).toBeUndefined();
    expect(bounded.hintLadder?.skeleton).toBeUndefined();
  });

  it('keeps flat hints untouched when no ladder was produced', () => {
    const bounded = boundPracticeQuestion({
      title: 'Top customers',
      scenario: 'List the customers with the highest order totals.',
      hints: ['Flat hint one.', 'Flat hint two.'],
      tables: ['customers'],
    });
    expect(bounded.hints).toEqual(['Flat hint one.', 'Flat hint two.']);
    expect(bounded.hintLadder).toBeUndefined();
  });

  it('sanitizes the ladder on the public question shape', () => {
    const pub = toPublicPracticeQuestion(
      question({
        hints: ['Look at the join clause.', 'SELECT password FROM users'],
        hintLadder: {
          nudge: 'Look at the join clause.',
          approach: 'Match orders to their customer.',
          skeleton: 'SELECT password FROM users',
        },
      }),
    );
    expect(pub.hints).toEqual(['Look at the join clause.']);
    expect(pub.hintLadder).toEqual({
      nudge: 'Look at the join clause.',
      approach: 'Match orders to their customer.',
    });
  });

  it('omits the ladder from the public shape when no tier survives', () => {
    const pub = toPublicPracticeQuestion(
      question({
        hintLadder: { nudge: 'SELECT c.id FROM customers c' },
      }),
    );
    expect(pub.hintLadder).toBeUndefined();
  });

  it('runs the leak filter per tier through the shared helper', () => {
    const filtered = filterPracticeHintLadder(
      {
        nudge: 'Check the WHERE clause.',
        skeleton: 'select whatever from customers',
      },
      ['customers'],
    );
    expect(filtered).toEqual({ nudge: 'Check the WHERE clause.' });
    expect(
      filterPracticeHintLadder({ skeleton: 'SELECT … FROM … WHERE …' }, ['customers']),
    ).toEqual({ skeleton: 'SELECT … FROM … WHERE …' });
  });
});

/* ------------------------------------------------------------------ */
/* Routes: review queue and daily challenge                            */
/* ------------------------------------------------------------------ */

const user: PublicUser = {
  id: 'u1',
  username: 'tester',
  displayName: 'Tester',
  role: 'admin',
  assignments: [],
  createdAt: '2026-01-01T00:00:00Z',
  disabledAt: null,
};

function appWithUser(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: PublicUser }).user = user;
    next();
  });
  app.use('/api/practice', practiceRouter);
  return app;
}

type ReviewListResponse = { data: unknown[] };
type DailyResponse = {
  data: { date: string; set: { id: string; questions: unknown[] } | null; reason?: string };
};

async function getJson<T>(server: Server, url: string): Promise<{ status: number; body: T }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${url}`);
  return { status: response.status, body: (await response.json()) as T };
}

describe('GET /api/practice/review and DELETE /api/practice/review/:setId/:questionId', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('lists due items with the question text and never the reference answers', async () => {
    const profile = 'profile-review-http';
    const setId = 'set-review-http';
    await savePracticeSet(
      practiceSet(setId, profile, [
        question({ id: 'q-http', title: 'HTTP due question', scenario: 'Find the http rows.' }),
      ]),
    );
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId: 'q-http',
      verdict: 'incorrect',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(new Date(Date.now() - 2 * DAY_MS)),
    });

    server = appWithUser().listen(0);
    const { status, body } = await getJson<ReviewListResponse>(
      server,
      `/api/practice/review?profileId=${profile}`,
    );
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      setId,
      questionId: 'q-http',
      title: 'HTTP due question',
      scenario: 'Find the http rows.',
      topics: ['joins'],
      difficulty: 'medium',
      box: 0,
      lastVerdict: 'incorrect',
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('referenceSql');
    expect(serialized).not.toContain('expectedResult');
    expect(serialized).not.toContain('brokenSql');
    expect(serialized).not.toContain('c.id, c.name');
  });

  it('dismisses an item and reports a miss for an unknown one', async () => {
    const profile = 'profile-review-dismiss';
    const setId = 'set-review-dismiss';
    await savePracticeSet(practiceSet(setId, profile, [question({ id: 'q-dismiss' })]));
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId: 'q-dismiss',
      verdict: 'close',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(new Date(Date.now() - 2 * DAY_MS)),
    });

    server = appWithUser().listen(0);
    const { port } = server.address() as AddressInfo;
    const first = await fetch(
      `http://127.0.0.1:${port}/api/practice/review/${setId}/q-dismiss?profileId=${profile}`,
      { method: 'DELETE' },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: { dismissed: true } });

    const second = await fetch(
      `http://127.0.0.1:${port}/api/practice/review/${setId}/q-dismiss?profileId=${profile}`,
      { method: 'DELETE' },
    );
    expect(await second.json()).toEqual({ data: { dismissed: false } });

    const listing = await getJson<ReviewListResponse>(
      server,
      `/api/practice/review?profileId=${profile}`,
    );
    expect(listing.body.data).toHaveLength(0);
  });
});

describe('GET /api/practice/daily', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    h.resolveProvider.mockReset();
    h.generatePracticeSet.mockReset();
  });

  it('falls back to an unattempted executable question when no provider is configured', async () => {
    h.resolveProvider.mockRejectedValue(
      new AppError('NO_AI_PROVIDER', 'No AI provider is configured. Add one in Settings.', 400),
    );
    const profile = 'profile-daily-fallback';
    const setId = 'set-daily-fallback';
    await savePracticeSet(
      practiceSet(setId, profile, [
        question({ id: 'q-done', execute: true }),
        question({ id: 'q-fresh', execute: true, referenceSql: 'SELECT secret FROM answers' }),
      ]),
    );
    // One question of the set was already attempted; the other must be picked.
    await addPracticeAttempt(
      attempt('a-done', profile, setId, 'q-done', iso(new Date(Date.now() - DAY_MS))),
    );

    server = appWithUser().listen(0);
    const { status, body } = await getJson<DailyResponse>(
      server,
      `/api/practice/daily?profileId=${profile}`,
    );
    expect(status).toBe(200);
    expect(body.data.date).toBe(localDateKey(new Date()));
    expect(body.data.set).not.toBeNull();
    expect(body.data.set?.id).toBe(setId);
    // The wire shape stays client-safe even for the fallback pick.
    expect(JSON.stringify(body)).not.toContain('secret FROM answers');

    // The fallback pick is persisted as the day's challenge.
    const entry = await getPracticeDailyEntry(PRACTICE_USER_ID, profile);
    expect(entry).toEqual({ date: localDateKey(new Date()), setId });
  });

  it('returns set: null with a reason when there is no provider and no candidate', async () => {
    h.resolveProvider.mockRejectedValue(
      new AppError('NO_AI_PROVIDER', 'No AI provider is configured. Add one in Settings.', 400),
    );
    server = appWithUser().listen(0);
    const { status, body } = await getJson<DailyResponse>(
      server,
      '/api/practice/daily?profileId=profile-daily-empty',
    );
    expect(status).toBe(200);
    expect(body.data.set).toBeNull();
    expect(body.data.reason).toBe('no-provider');
  });

  it('serves the stored entry for the rest of the day without touching the provider again', async () => {
    h.resolveProvider.mockRejectedValue(
      new AppError('NO_AI_PROVIDER', 'No AI provider is configured. Add one in Settings.', 400),
    );
    const profile = 'profile-daily-stable';
    await savePracticeSet(
      practiceSet('set-daily-stable', profile, [question({ id: 'q-stable', execute: true })]),
    );

    server = appWithUser().listen(0);
    const first = await getJson<DailyResponse>(server, `/api/practice/daily?profileId=${profile}`);
    expect(first.body.data.set).not.toBeNull();
    expect(first.body.data.set?.id).toBe('set-daily-stable');
    const second = await getJson<DailyResponse>(server, `/api/practice/daily?profileId=${profile}`);
    expect(second.body.data.set?.id).toBe('set-daily-stable');
    expect(h.resolveProvider).toHaveBeenCalledTimes(1);
  });

  it('keeps daily pointers stable and isolated for concurrent accounts', async () => {
    const profile = 'profile-daily-accounts';
    const userB = 'u2';
    const setA = 'set-daily-account-a';
    const setB = 'set-daily-account-b';
    await Promise.all([
      savePracticeSet(practiceSet(setA, profile, [question({ id: 'q-daily-a' })])),
      savePracticeSet({
        ...practiceSet(setB, profile, [question({ id: 'q-daily-b' })]),
        userId: userB,
      }),
    ]);
    const date = localDateKey(new Date());
    await Promise.all([
      setPracticeDailyEntry(PRACTICE_USER_ID, profile, { date, setId: setA }),
      setPracticeDailyEntry(userB, profile, { date, setId: setB }),
    ]);

    const [entryA, entryB] = await Promise.all([
      getPracticeDailyEntry(PRACTICE_USER_ID, profile),
      getPracticeDailyEntry(userB, profile),
    ]);
    expect(entryA).toEqual({ date, setId: setA });
    expect(entryB).toEqual({ date, setId: setB });

    await setPracticeDailyEntry(PRACTICE_USER_ID, profile, { date, setId: setA });
    expect(await getPracticeDailyEntry(userB, profile)).toEqual({ date, setId: setB });
  });

  it('generates a one-question medium challenge on the weakest topics', async () => {
    h.resolveProvider.mockResolvedValue({
      stored: { id: 'p1' },
      public: {
        id: 'p1',
        name: 'Mock',
        type: 'openai',
        model: 'mock-1',
        temperature: 0.3,
        maxTokens: 1024,
        streaming: false,
        isDefault: true,
      },
      apiKey: 'key',
    });
    const profile = 'profile-daily-gen';
    const seedSet = practiceSet('set-daily-gen-seed', profile, [question({ id: 'q-seed' })]);
    await savePracticeSet(seedSet);
    await addPracticeAttempt(
      attempt(
        'a-seed',
        profile,
        'set-daily-gen-seed',
        'q-seed',
        iso(new Date(Date.now() - DAY_MS)),
      ),
    );

    const generated: PracticeSet = {
      ...practiceSet('set-daily-gen', profile, [
        question({ id: 'q-generated', difficulty: 'medium' }),
      ]),
      summary: 'Daily challenge',
    };
    // The real generation persists the set with the authenticated owner; the
    // mock mirrors that contract so the route can serve it immediately.
    h.generatePracticeSet.mockImplementation(async () => {
      await savePracticeSet(generated);
      return { set: generated, raw: '' };
    });

    server = appWithUser().listen(0);
    const { status, body } = await getJson<DailyResponse>(
      server,
      `/api/practice/daily?profileId=${profile}`,
    );
    expect(status).toBe(200);
    expect(body.data.set).not.toBeNull();
    expect(body.data.set?.id).toBe('set-daily-gen');

    // One question, medium difficulty, grounded in the profile's latest database.
    expect(h.generatePracticeSet).toHaveBeenCalledTimes(1);
    const request = h.generatePracticeSet.mock.calls[0][0];
    expect(request.count).toBe(1);
    expect(request.difficulty).toBe('medium');
    expect(request.database).toBe('shop');
    expect(request.topics).toEqual(
      (await getPracticeProgress(profile, PRACTICE_USER_ID)).recommendedTopics,
    );

    // The generated set was persisted, owned and recorded as today's challenge.
    expect(body.data.set?.questions[0]).not.toHaveProperty('referenceSql');
    const entry = await getPracticeDailyEntry(PRACTICE_USER_ID, profile);
    expect(entry).toEqual({ date: localDateKey(new Date()), setId: 'set-daily-gen' });
    const sets = await import('../server/store/practice');
    const owned = (await sets.listPracticeSets(profile, 10, PRACTICE_USER_ID)).find(
      (item) => item.id === 'set-daily-gen',
    );
    expect(owned?.userId).toBe(user.id);
  });
});

/*
 * Last on purpose: pushing the 40-set cap evicts every set saved above, so no
 * earlier test may still need its set once this runs.
 */
describe('review items referencing evicted sets', () => {
  it('skips a due item whose set fell out of the store cap and prunes it', async () => {
    const profile = 'profile-evict';
    const setId = 'set-evict';
    await savePracticeSet(practiceSet(setId, profile, [question({ id: 'q-evict' })]));
    await recordPracticeReviewOutcome({
      userId: PRACTICE_USER_ID,
      profileId: profile,
      setId,
      questionId: 'q-evict',
      verdict: 'close',
      topics: ['joins'],
      difficulty: 'medium',
      attemptedAt: iso(new Date(Date.now() - 2 * DAY_MS)),
    });
    expect(await listDuePracticeReviewItems(PRACTICE_USER_ID, profile)).toHaveLength(1);

    // 40 newer sets push `set-evict` (and every older set) out of the 40-set cap.
    for (let index = 0; index < 40; index += 1) {
      await savePracticeSet(
        practiceSet(`set-filler-${index}`, profile, [question({ id: `q-filler-${index}` })]),
      );
    }

    // The listing skips the evicted reference and prunes the stale item.
    expect(await listDuePracticeReviewItems(PRACTICE_USER_ID, profile)).toHaveLength(0);
    expect(reviewItems(profile)).toHaveLength(0);
  });
});
