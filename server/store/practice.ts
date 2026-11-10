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

/** One spaced-repetition item of a profile's review queue (at-rest shape). */
export interface PracticeReviewItem {
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

interface PracticeFile {
  sets: PracticeSet[];
  attempts: PracticeAttempt[];
  /** Per-profile review queues. Absent on files written before the learning loop. */
  reviews?: Record<string, PracticeReviewItem[]>;
  /** Per-profile daily challenge pointers. Absent on files written before the learning loop. */
  daily?: Record<string, PracticeDailyEntry>;
}

const store = new JsonStore<PracticeFile>(path.join(DATA_DIR, 'practice.json'), () => ({
  sets: [],
  attempts: [],
  reviews: {},
  daily: {},
}));

const MAX_SETS = 40;
const MAX_ATTEMPTS = 1_500;
const MAX_REVIEW_ITEMS_PER_PROFILE = 500;

export async function savePracticeSet(set: PracticeSet): Promise<PracticeSet> {
  await store.update((current) => ({
    ...current,
    sets: [set, ...current.sets.filter((item) => item.id !== set.id)].slice(0, MAX_SETS),
  }));
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

export async function listPracticeSets(
  profileId?: string,
  limit = 20,
  userId?: string,
): Promise<PracticeSet[]> {
  const file = await store.read();
  let sets = profileId ? file.sets.filter((set) => set.profileId === profileId) : file.sets;
  // Members see only the sets they generated; pre-admin sets are admin-only.
  if (userId) {
    sets = sets.filter((set) => set.userId === userId);
  }
  return sets.slice(0, Math.max(1, Math.min(50, limit)));
}

/** Records who generated a set; called right after the set is persisted. */
export async function stampPracticeSetOwner(setId: string, userId: string): Promise<void> {
  await store.update((current) => ({
    ...current,
    sets: current.sets.map((set) => (set.id === setId ? { ...set, userId } : set)),
  }));
}

export async function addPracticeAttempt(attempt: PracticeAttempt): Promise<PracticeAttempt> {
  await store.update((current) => ({
    ...current,
    attempts: [attempt, ...current.attempts].slice(0, MAX_ATTEMPTS),
  }));
  return attempt;
}

export async function listPracticeAttempts(
  profileId?: string,
  limit = 30,
  userId?: string,
): Promise<PracticeAttempt[]> {
  const file = await store.read();
  let attempts = profileId
    ? file.attempts.filter((attempt) => attempt.profileId === profileId)
    : file.attempts;
  if (userId) {
    attempts = attempts.filter((attempt) => attempt.userId === userId);
  }
  return attempts.slice(0, Math.max(1, Math.min(100, limit)));
}

/**
 * Every recorded attempt for one set, independent of the listing window used by
 * `listPracticeAttempts`. Used for duplicate detection and for deciding whether a
 * question's answer material may be released.
 */
export async function listPracticeAttemptsForSet(
  profileId: string,
  setId: string,
  userId?: string,
): Promise<PracticeAttempt[]> {
  const file = await store.read();
  let filtered = file.attempts.filter(
    (attempt) => attempt.profileId === profileId && attempt.setId === setId,
  );
  if (userId) {
    filtered = filtered.filter((attempt) => attempt.userId === userId);
  }
  return filtered;
}

/** Records who submitted an attempt; called right after it is persisted. */
export async function stampPracticeAttemptOwner(
  profileId: string,
  setId: string,
  questionId: string,
  userId: string,
): Promise<void> {
  await store.update((current) => ({
    ...current,
    attempts: current.attempts.map((attempt) =>
      attempt.profileId === profileId &&
      attempt.setId === setId &&
      attempt.questionId === questionId
        ? { ...attempt, userId }
        : attempt,
    ),
  }));
}

export async function clearPracticeAttempts(profileId?: string, userId?: string): Promise<void> {
  await store.update((current) => ({
    ...current,
    attempts: current.attempts.filter((attempt) => {
      const matchesProfile = profileId ? attempt.profileId === profileId : true;
      const matchesUser = userId ? attempt.userId === userId : true;
      return !(matchesProfile && matchesUser);
    }),
  }));
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
  userId?: string,
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
  item: Pick<PracticeReviewItem, 'profileId' | 'setId' | 'questionId'>,
  profileId: string,
  setId: string,
  questionId: string,
): boolean {
  return item.profileId === profileId && item.setId === setId && item.questionId === questionId;
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
  // A local copy: narrowing of an object property does not survive into the
  // `store.update` closure below.
  const verdict: PracticeReviewVerdict = input.verdict;
  await store.update((current) => {
    const reviews = { ...(current.reviews ?? {}) };
    const profileReviews = reviews[input.profileId] ?? [];
    const existing =
      profileReviews.find((item) =>
        sameReviewKey(item, input.profileId, input.setId, input.questionId),
      ) ?? null;

    let next: PracticeReviewItem | null;
    if (input.verdict === 'correct') {
      const box = (existing?.box ?? 0) + 1;
      next =
        box > REVIEW_GRADUATION_BOX
          ? null
          : {
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

    const rest = profileReviews.filter(
      (item) => !sameReviewKey(item, input.profileId, input.setId, input.questionId),
    );
    // Ordered by last touch so the cap evicts the least recently reviewed item.
    const combined = (next ? [...rest, next] : rest).sort((a, b) =>
      a.lastAttemptAt.localeCompare(b.lastAttemptAt),
    );
    reviews[input.profileId] = combined.slice(-MAX_REVIEW_ITEMS_PER_PROFILE);
    return { ...current, reviews };
  });
}

/** Dismisses one review item. Returns true when an item was removed. */
export async function removePracticeReviewItem(
  profileId: string,
  setId: string,
  questionId: string,
): Promise<boolean> {
  let removed = false;
  await store.update((current) => {
    const reviews = { ...(current.reviews ?? {}) };
    const profileReviews = reviews[profileId] ?? [];
    const next = profileReviews.filter((item) => {
      const match = sameReviewKey(item, profileId, setId, questionId);
      if (match) removed = true;
      return !match;
    });
    reviews[profileId] = next;
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
 * The profile's due review items (`dueAt <= now`), ordered by dueAt, each
 * resolved to its question text. Items whose set or question has been evicted
 * by the store caps (40 sets / 1500 attempts) are skipped and opportunistically
 * pruned; for members, items on sets they did not generate are skipped too.
 */
export async function listDuePracticeReviewItems(
  profileId: string,
  userId?: string,
  now: Date = new Date(),
): Promise<ResolvedPracticeReviewItem[]> {
  const file = await store.read();
  const nowIso = now.toISOString();
  const due = (file.reviews?.[profileId] ?? [])
    .filter((item) => item.dueAt <= nowIso)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  if (due.length === 0) return [];

  const setsById = new Map(file.sets.map((set) => [set.id, set]));
  const resolved: ResolvedPracticeReviewItem[] = [];
  const stale: PracticeReviewItem[] = [];
  for (const item of due) {
    const set = setsById.get(item.setId);
    const question = set?.questions.find((entry) => entry.id === item.questionId);
    if (!set || !question) {
      stale.push(item);
      continue;
    }
    if (userId && set.userId !== userId) {
      // Members only review sets they generated, mirroring the set listings.
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
        [profileId]: (current.reviews?.[profileId] ?? []).filter(
          (item) => !staleKeys.has(`${item.setId}/${item.questionId}`),
        ),
      },
    }));
  }
  return resolved;
}

/* ------------------------------------------------------------------ */
/* Daily challenge pointer                                             */
/* ------------------------------------------------------------------ */

export async function getPracticeDailyEntry(profileId: string): Promise<PracticeDailyEntry | null> {
  const file = await store.read();
  return file.daily?.[profileId] ?? null;
}

export async function setPracticeDailyEntry(
  profileId: string,
  entry: PracticeDailyEntry,
): Promise<void> {
  await store.update((current) => ({
    ...current,
    daily: { ...(current.daily ?? {}), [profileId]: entry },
  }));
}
