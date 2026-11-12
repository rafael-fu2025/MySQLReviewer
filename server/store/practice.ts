import path from 'node:path';
import type {
  PracticeAttempt,
  PracticeDailyEntry,
  PracticeDifficulty,
  PracticeEvaluation,
  PracticeProgress,
  PracticeProgressTopic,
  PracticeReviewVerdict,
  PracticeSet,
  PracticeTopic,
} from '../../shared/types';
import { PRACTICE_REVIEW_INTERVAL_DAYS, PRACTICE_TOPICS } from '../../shared/types';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import { JsonStore } from './json-store';

/** One spaced-repetition item of an account's profile review queue (at-rest shape). */
export interface PracticeReviewItem {
  userId: string;
  profileId: string;
  setId: string;
  questionId: string;
  /** SM-2-lite box 0..4; a `correct` at box 4 graduates the item out. */
  box: number;
  /** ISO timestamp; the item is due when this is in the past. */
  dueAt: string;
  lastVerdict: PracticeReviewVerdict;
  lastAttemptAt: string;
  topics: PracticeTopic[];
  difficulty: PracticeDifficulty;
}

/** A daily pointer carries its owner as a second guard beyond the composite map key. */
interface OwnedPracticeDailyEntry extends PracticeDailyEntry {
  userId: string;
  profileId: string;
}

interface PracticeFile {
  sets: PracticeSet[];
  attempts: PracticeAttempt[];
  /**
   * Per-account + profile review queues. Older files used bare profile ids;
   * those keys are deliberately never read as an account queue.
   */
  reviews?: Record<string, PracticeReviewItem[]>;
  /**
   * Per-account + profile daily pointers. Older bare-profile pointers remain
   * inert instead of being claimed by the first account that asks for one.
   */
  daily?: Record<string, PracticeDailyEntry | OwnedPracticeDailyEntry>;
}

const store = new JsonStore<PracticeFile>(path.join(DATA_DIR, 'practice.json'), () => ({
  sets: [],
  attempts: [],
  reviews: {},
  daily: {},
}));

const MAX_SETS_PER_USER = 40;
const MAX_ATTEMPTS_PER_USER = 1_500;
const MAX_REVIEW_ITEMS_PER_USER_PROFILE = 500;

function accountProfileKey(userId: string, profileId: string): string {
  return `${encodeURIComponent(userId)}:${encodeURIComponent(profileId)}`;
}

function retainForUser<T extends { userId?: string }>(
  items: T[],
  userId: string,
  maxForUser: number,
): T[] {
  let seen = 0;
  return items.filter((item) => item.userId !== userId || ++seen <= maxForUser);
}

/**
 * Applies the per-account cap to a newest-first list. Exported for a fast,
 * deterministic boundary test; production set and attempt writes use this same
 * function inside their atomic JsonStore updates.
 */
export function retainPracticeItemsForUser<T extends { userId?: string }>(
  items: T[],
  userId: string,
  maxForUser: number,
): T[] {
  return retainForUser(items, userId, maxForUser);
}

/** Test-visible storage limits; production writes enforce each limit per account. */
export const PRACTICE_RETENTION = {
  setsPerUser: MAX_SETS_PER_USER,
  attemptsPerUser: MAX_ATTEMPTS_PER_USER,
  reviewsPerUserProfile: MAX_REVIEW_ITEMS_PER_USER_PROFILE,
} as const;

export async function savePracticeSet(set: PracticeSet): Promise<PracticeSet> {
  if (!set.userId) {
    throw new AppError('AUTH_REQUIRED', 'Sign in to save a practice set.', 401);
  }
  const ownerId = set.userId;
  await store.update((current) => {
    const existing = current.sets.find((item) => item.id === set.id);
    if (existing && existing.userId !== ownerId) {
      throw new AppError(
        'PRACTICE_SET_FORBIDDEN',
        'This practice set belongs to another account.',
        403,
      );
    }
    const next = [set, ...current.sets.filter((item) => item.id !== set.id)];
    return {
      ...current,
      sets: retainPracticeItemsForUser(next, ownerId, MAX_SETS_PER_USER),
    };
  });
  return set;
}

export async function getPracticeSet(id: string): Promise<PracticeSet> {
  const file = await store.read();
  const set = file.sets.find((item) => item.id === id);
  if (!set) {
    throw new AppError('PRACTICE_SET_NOT_FOUND', 'Practice set not found.', 404);
  }
  return set;
}

export async function getOwnedPracticeSet(id: string, userId: string): Promise<PracticeSet> {
  const set = await getPracticeSet(id);
  // Legacy unattributed sets fail closed here; direct internal reads can still
  // inspect them, but no account can claim or evaluate them.
  if (!set.userId || set.userId !== userId) {
    throw new AppError(
      'PRACTICE_SET_FORBIDDEN',
      'This practice set belongs to another account.',
      403,
    );
  }
  return set;
}

export async function listPracticeSets(
  profileId: string,
  limit = 20,
  userId: string,
): Promise<PracticeSet[]> {
  const file = await store.read();
  return file.sets
    .filter((set) => set.profileId === profileId && set.userId === userId)
    .slice(0, Math.max(1, Math.min(50, limit)));
}

export async function addPracticeAttempt(attempt: PracticeAttempt): Promise<PracticeAttempt> {
  if (!attempt.userId) {
    throw new AppError('AUTH_REQUIRED', 'Sign in to save a practice attempt.', 401);
  }
  const ownerId = attempt.userId;
  await store.update((current) => {
    const existing = current.attempts.find((item) => item.id === attempt.id);
    if (existing && existing.userId !== ownerId) {
      throw new AppError(
        'PRACTICE_ATTEMPT_FORBIDDEN',
        'This practice attempt belongs to another account.',
        403,
      );
    }
    const next = [attempt, ...current.attempts.filter((item) => item.id !== attempt.id)];
    return {
      ...current,
      attempts: retainPracticeItemsForUser(next, ownerId, MAX_ATTEMPTS_PER_USER),
    };
  });
  return attempt;
}

export async function listPracticeAttempts(
  profileId: string,
  limit = 30,
  userId: string,
): Promise<PracticeAttempt[]> {
  const file = await store.read();
  return file.attempts
    .filter((attempt) => attempt.profileId === profileId && attempt.userId === userId)
    .slice(0, Math.max(1, Math.min(100, limit)));
}

/**
 * Every recorded attempt for one account and set, independent of the listing
 * window. Used for duplicate detection and answer-release decisions.
 */
export async function listPracticeAttemptsForSet(
  profileId: string,
  setId: string,
  userId: string,
): Promise<PracticeAttempt[]> {
  const file = await store.read();
  return file.attempts.filter(
    (attempt) =>
      attempt.profileId === profileId && attempt.setId === setId && attempt.userId === userId,
  );
}

export async function clearPracticeAttempts(profileId: string, userId: string): Promise<void> {
  await store.update((current) => ({
    ...current,
    attempts: current.attempts.filter(
      (attempt) => !(attempt.profileId === profileId && attempt.userId === userId),
    ),
  }));
}

/**
 * Atomically removes every account-owned practice artifact. Legacy ownerless
 * data is left quarantined, and entries owned by every other account survive.
 */
export async function deletePracticeDataForUser(userId: string): Promise<void> {
  if (!userId) {
    throw new AppError('AUTH_REQUIRED', 'Practice data cleanup requires an account.', 401);
  }
  await store.update((current) => {
    const reviews = Object.fromEntries(
      Object.entries(current.reviews ?? {}).map(([key, items]) => [
        key,
        items.filter((item) => item.userId !== userId),
      ]),
    );
    const daily = Object.fromEntries(
      Object.entries(current.daily ?? {}).filter(([, entry]) => {
        const owned = entry as Partial<OwnedPracticeDailyEntry>;
        return owned.userId !== userId;
      }),
    );
    return {
      ...current,
      sets: current.sets.filter((set) => set.userId !== userId),
      attempts: current.attempts.filter((attempt) => attempt.userId !== userId),
      reviews,
      daily,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Streaks and XP                                                      */
/* ------------------------------------------------------------------ */

/**
 * Local calendar date (`YYYY-MM-DD`) of an ISO timestamp.
 *
 * Streaks follow the user's local clock, not UTC: this is a local-first app,
 * and "practiced today" means the day the user is living in. A 23:30 session
 * that spans midnight UTC must still count for one local day, not two.
 */
export function localDateKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  // The store tolerates documents written by older versions, so anything that
  // is not a parsable timestamp yields no day key instead of throwing.
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local calendar date `offsetDays` days before `base` (base 0 = today). */
function localDateKeyOffset(base: Date, offsetDays: number): string {
  return localDateKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - offsetDays));
}

/** Days between two `YYYY-MM-DD` keys (month and year boundaries included). */
function dayNumber(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year || 1970, (month || 1) - 1, day || 1) / 86_400_000;
}

/**
 * Streak statistics over a set of local day keys.
 *
 * `currentStreak` counts consecutive days ending today; a day that is not over
 * yet does not break the streak, so a history ending yesterday still counts as
 * alive today. `longestStreak` is the longest consecutive run anywhere in the
 * retained history.
 */
export function practiceStreakStats(
  dayKeys: readonly string[],
  today: Date,
): { currentStreak: number; longestStreak: number } {
  const days = new Set(dayKeys.filter((key) => key.length > 0));

  // Current streak: start at today when something was recorded today,
  // otherwise at yesterday (today is still open).
  let currentStreak = 0;
  const startOffset = days.has(localDateKeyOffset(today, 0))
    ? 0
    : days.has(localDateKeyOffset(today, 1))
      ? 1
      : null;
  if (startOffset !== null) {
    let offset = startOffset;
    while (days.has(localDateKeyOffset(today, offset))) {
      currentStreak += 1;
      offset += 1;
    }
  }

  // Longest run: scan the sorted, day-numbered history.
  const numbers = Array.from(days)
    .map(dayNumber)
    .sort((a, b) => a - b);
  let longestStreak = 0;
  let run = 0;
  let previous: number | null = null;
  for (const number of numbers) {
    run = previous !== null && number - previous === 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = number;
  }
  return { currentStreak, longestStreak };
}

/** XP base points per verdict; `incorrect` and `not-executed` earn nothing. */
const PRACTICE_XP_BASE: Record<'correct' | 'close', number> = { correct: 10, close: 4 };

const PRACTICE_DIFFICULTY_MULTIPLIER: Record<PracticeDifficulty, number> = {
  easy: 1,
  medium: 1.5,
  hard: 2,
};

/** XP awarded for one attempt: verdict base × difficulty multiplier. */
export function practiceXpForAttempt(
  verdict: PracticeEvaluation['verdict'],
  difficulty: PracticeDifficulty,
): number {
  const base = PRACTICE_XP_BASE[verdict as 'correct' | 'close'];
  if (base === undefined) return 0;
  return Math.round(base * PRACTICE_DIFFICULTY_MULTIPLIER[difficulty]);
}

export async function getPracticeProgress(
  profileId: string,
  userId: string,
): Promise<PracticeProgress> {
  const attempts = await listPracticeAttempts(profileId, 500, userId);
  const topicMap = new Map<PracticeTopic, { attempts: number; total: number; best: number }>();
  for (const item of PRACTICE_TOPICS) {
    topicMap.set(item.id, { attempts: 0, total: 0, best: 0 });
  }
  const dayKeys = new Set<string>();
  let xp = 0;
  for (const attempt of attempts) {
    for (const topic of attempt.topics) {
      const current = topicMap.get(topic);
      if (!current) continue;
      current.attempts += 1;
      current.total += attempt.evaluation.scores.overall;
      current.best = Math.max(current.best, attempt.evaluation.scores.overall);
    }
    dayKeys.add(localDateKey(attempt.createdAt));
    xp += practiceXpForAttempt(attempt.evaluation.verdict, attempt.difficulty);
  }

  const topics: PracticeProgressTopic[] = Array.from(topicMap.entries()).map(([topic, value]) => ({
    topic,
    attempts: value.attempts,
    averageScore: value.attempts > 0 ? Math.round(value.total / value.attempts) : 0,
    bestScore: value.best,
  }));

  const attempted = topics.filter((topic) => topic.attempts > 0);
  const unattempted = topics.filter((topic) => topic.attempts === 0);
  const recommended = [
    ...attempted.sort((a, b) => a.averageScore - b.averageScore).map((topic) => topic.topic),
    ...unattempted.map((topic) => topic.topic),
  ].slice(0, 4);

  const streaks = practiceStreakStats(Array.from(dayKeys), new Date());

  return {
    totalAttempts: attempts.length,
    averageScore:
      attempts.length > 0
        ? Math.round(
            attempts.reduce((sum, attempt) => sum + attempt.evaluation.scores.overall, 0) /
              attempts.length,
          )
        : 0,
    topics,
    recent: attempts.slice(0, 8),
    recommendedTopics: recommended,
    currentStreak: streaks.currentStreak,
    longestStreak: streaks.longestStreak,
    xp: Math.round(xp),
  };
}

/* ------------------------------------------------------------------ */
/* Spaced-repetition review queue (SM-2-lite / 2357)                   */
/* ------------------------------------------------------------------ */

/** Days a `correct` answer pushes the item out, indexed by the box just left. */
const REVIEW_INTERVAL_DAYS = PRACTICE_REVIEW_INTERVAL_DAYS;
const REVIEW_GRADUATION_BOX = 4;

function addDaysIso(iso: string, days: number): string {
  const date = new Date(iso);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function sameReviewKey(
  item: Pick<PracticeReviewItem, 'userId' | 'profileId' | 'setId' | 'questionId'>,
  userId: string,
  profileId: string,
  setId: string,
  questionId: string,
): boolean {
  return (
    item.userId === userId &&
    item.profileId === profileId &&
    item.setId === setId &&
    item.questionId === questionId
  );
}

/**
 * Applies the SM-2-lite transition for one recorded attempt and stores it.
 *
 * - `incorrect` / `close`: the item goes back to box 0 and is due in 1 day.
 * - `correct`: the item moves to the next box and is due in
 *   `[3, 7, 14, 30][box]` days; a correct answer at box 4 graduates and the
 *   item is removed.
 * - `not-executed` verdicts never touch the queue (the answer was not graded).
 *
 * The duplicate-submission path in `evaluatePractice` returns before the
 * attempt is stored, so a duplicate never reaches this function.
 */
export async function recordPracticeReviewOutcome(input: {
  userId: string;
  profileId: string;
  setId: string;
  questionId: string;
  verdict: PracticeEvaluation['verdict'];
  topics: PracticeTopic[];
  difficulty: PracticeDifficulty;
  /** ISO timestamp of the recorded attempt. */
  attemptedAt: string;
}): Promise<void> {
  if (input.verdict !== 'correct' && input.verdict !== 'close' && input.verdict !== 'incorrect') {
    return;
  }
  const verdict: PracticeReviewVerdict = input.verdict;
  await store.update((current) => {
    const reviews = { ...(current.reviews ?? {}) };
    const key = accountProfileKey(input.userId, input.profileId);
    const accountReviews = (reviews[key] ?? []).filter(
      (item) => item.userId === input.userId && item.profileId === input.profileId,
    );
    const existing =
      accountReviews.find((item) =>
        sameReviewKey(item, input.userId, input.profileId, input.setId, input.questionId),
      ) ?? null;

    let next: PracticeReviewItem | null;
    if (input.verdict === 'correct') {
      const box = (existing?.box ?? 0) + 1;
      next =
        box > REVIEW_GRADUATION_BOX
          ? null
          : {
              userId: input.userId,
              profileId: input.profileId,
              setId: input.setId,
              questionId: input.questionId,
              box,
              dueAt: addDaysIso(input.attemptedAt, REVIEW_INTERVAL_DAYS[box - 1]),
              lastVerdict: 'correct',
              lastAttemptAt: input.attemptedAt,
              topics: input.topics,
              difficulty: input.difficulty,
            };
    } else {
      next = {
        userId: input.userId,
        profileId: input.profileId,
        setId: input.setId,
        questionId: input.questionId,
        box: 0,
        dueAt: addDaysIso(input.attemptedAt, 1),
        lastVerdict: verdict,
        lastAttemptAt: input.attemptedAt,
        topics: input.topics,
        difficulty: input.difficulty,
      };
    }

    const rest = accountReviews.filter(
      (item) => !sameReviewKey(item, input.userId, input.profileId, input.setId, input.questionId),
    );
    // Ordered by last touch so the per-account/profile cap evicts only that
    // account's least recently reviewed item.
    const combined = (next ? [...rest, next] : rest).sort((a, b) =>
      a.lastAttemptAt.localeCompare(b.lastAttemptAt),
    );
    reviews[key] = combined.slice(-MAX_REVIEW_ITEMS_PER_USER_PROFILE);
    return { ...current, reviews };
  });
}

/** Dismisses one account-owned review item. Returns true when one was removed. */
export async function removePracticeReviewItem(
  userId: string,
  profileId: string,
  setId: string,
  questionId: string,
): Promise<boolean> {
  let removed = false;
  await store.update((current) => {
    const reviews = { ...(current.reviews ?? {}) };
    const key = accountProfileKey(userId, profileId);
    const accountReviews = reviews[key] ?? [];
    const next = accountReviews.filter((item) => {
      const match = sameReviewKey(item, userId, profileId, setId, questionId);
      if (match) removed = true;
      return !match;
    });
    reviews[key] = next;
    return { ...current, reviews };
  });
  return removed;
}

/** One due review item resolved against its stored question. */
export interface ResolvedPracticeReviewItem {
  item: PracticeReviewItem;
  title: string;
  scenario: string;
}

/**
 * One account's due review items (`dueAt <= now`), ordered by dueAt and
 * resolved to question text. Legacy unattributed queues are never consulted.
 */
export async function listDuePracticeReviewItems(
  userId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<ResolvedPracticeReviewItem[]> {
  const file = await store.read();
  const key = accountProfileKey(userId, profileId);
  const nowIso = now.toISOString();
  const due = (file.reviews?.[key] ?? [])
    .filter(
      (item) => item.userId === userId && item.profileId === profileId && item.dueAt <= nowIso,
    )
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  if (due.length === 0) return [];

  const setsById = new Map(
    file.sets
      .filter((set) => set.userId === userId && set.profileId === profileId)
      .map((set) => [set.id, set]),
  );
  const resolved: ResolvedPracticeReviewItem[] = [];
  const stale: PracticeReviewItem[] = [];
  for (const item of due) {
    const set = setsById.get(item.setId);
    const question = set?.questions.find((entry) => entry.id === item.questionId);
    if (!set || !question) {
      stale.push(item);
      continue;
    }
    resolved.push({ item, title: question.title, scenario: question.scenario });
  }

  if (stale.length > 0) {
    const staleKeys = new Set(stale.map((item) => `${item.setId}/${item.questionId}`));
    await store.update((current) => ({
      ...current,
      reviews: {
        ...(current.reviews ?? {}),
        [key]: (current.reviews?.[key] ?? []).filter(
          (item) =>
            item.userId !== userId ||
            item.profileId !== profileId ||
            !staleKeys.has(`${item.setId}/${item.questionId}`),
        ),
      },
    }));
  }
  return resolved;
}

/* ------------------------------------------------------------------ */
/* Daily challenge pointer                                             */
/* ------------------------------------------------------------------ */

export async function getPracticeDailyEntry(
  userId: string,
  profileId: string,
): Promise<PracticeDailyEntry | null> {
  const file = await store.read();
  const entry = file.daily?.[accountProfileKey(userId, profileId)];
  if (!entry) return null;
  const owned = entry as Partial<OwnedPracticeDailyEntry>;
  return owned.userId === userId && owned.profileId === profileId
    ? { date: entry.date, setId: entry.setId }
    : null;
}

export async function setPracticeDailyEntry(
  userId: string,
  profileId: string,
  entry: PracticeDailyEntry,
): Promise<void> {
  await store.update((current) => ({
    ...current,
    daily: {
      ...(current.daily ?? {}),
      [accountProfileKey(userId, profileId)]: { ...entry, userId, profileId },
    },
  }));
}
