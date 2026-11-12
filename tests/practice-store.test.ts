import { describe, expect, it, vi } from 'vitest';
import type { PracticeAttempt, PracticeSet } from '../shared/types';

const memoryBackend = vi.hoisted(() => {
  const rows = new Map<string, string>();
  return {
    async ping(): Promise<void> {},
    async read(key: string): Promise<string | null> {
      return rows.get(key) ?? null;
    },
    async write(key: string, value: string): Promise<void> {
      rows.set(key, value);
    },
    async remove(key: string): Promise<void> {
      rows.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...rows.keys()];
    },
    describe() {
      return { backend: 'mysql' as const, database: 'practice-store-test-memory' };
    },
  };
});

// Retention needs to cross the real 1,500-attempt boundary. Keep the production
// JsonStore/update path but remove filesystem and Windows ACL latency from this
// store-focused test; persistence itself is covered by document-backend tests.
vi.mock('../server/store/document-backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/document-backend')>();
  return { ...actual, getDocumentBackend: () => memoryBackend };
});
import {
  addPracticeAttempt,
  clearPracticeAttempts,
  deletePracticeDataForUser,
  getPracticeDailyEntry,
  getPracticeSet,
  listDuePracticeReviewItems,
  listPracticeAttempts,
  listPracticeAttemptsForSet,
  listPracticeSets,
  PRACTICE_RETENTION,
  recordPracticeReviewOutcome,
  removePracticeReviewItem,
  retainPracticeItemsForUser,
  savePracticeSet,
  setPracticeDailyEntry,
} from '../server/store/practice';

const USER_A = 'practice-store-user-a';
const USER_B = 'practice-store-user-b';

function practiceSet(id: string, profileId: string, userId = USER_A): PracticeSet {
  return {
    id,
    userId,
    profileId,
    createdAt: '2026-01-01T00:00:00.000Z',
    database: 'shop',
    providerId: 'provider-1',
    model: 'test-model',
    summary: 'One set',
    questions: [],
  };
}

function attempt(
  id: string,
  profileId: string,
  setId: string,
  questionId: string,
  createdAt: string,
  userId = USER_A,
): PracticeAttempt {
  return {
    id,
    userId,
    profileId,
    setId,
    questionId,
    database: 'shop',
    topics: ['select'],
    difficulty: 'medium',
    userSql: 'SELECT 1',
    userAnswer: '',
    evaluation: {
      questionId,
      executed: true,
      verdict: 'correct',
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

describe('practice attempt storage', () => {
  it('keeps the generated sets per connection and account', async () => {
    await savePracticeSet(practiceSet('set_store_a', 'profile-a'));
    await savePracticeSet(practiceSet('set_store_b', 'profile-b'));
    await savePracticeSet(practiceSet('set_store_foreign_owner', 'profile-a', USER_B));

    const forA = await listPracticeSets('profile-a', 20, USER_A);
    const forB = await listPracticeSets('profile-b', 20, USER_A);
    expect(forA.map((item) => item.id)).toContain('set_store_a');
    expect(forA.map((item) => item.id)).not.toContain('set_store_b');
    expect(forA.map((item) => item.id)).not.toContain('set_store_foreign_owner');
    expect(forB.map((item) => item.id)).toContain('set_store_b');
    expect((await getPracticeSet('set_store_a')).profileId).toBe('profile-a');
  });

  it('keeps the graded answers per connection and per set', async () => {
    await savePracticeSet(practiceSet('set_store_answers', 'profile-answers'));
    await savePracticeSet(practiceSet('set_store_other', 'profile-answers'));
    await addPracticeAttempt(
      attempt(
        'attempt_store_1',
        'profile-answers',
        'set_store_answers',
        'q1',
        '2026-01-01T00:00:00.000Z',
      ),
    );
    await addPracticeAttempt(
      attempt(
        'attempt_store_2',
        'profile-answers',
        'set_store_answers',
        'q2',
        '2026-01-02T00:00:00.000Z',
      ),
    );
    await addPracticeAttempt(
      attempt(
        'attempt_store_3',
        'profile-answers',
        'set_store_other',
        'q1',
        '2026-01-03T00:00:00.000Z',
      ),
    );
    await addPracticeAttempt(
      attempt(
        'attempt_store_4',
        'profile-foreign',
        'set_store_answers',
        'q1',
        '2026-01-04T00:00:00.000Z',
      ),
    );

    const attempts = await listPracticeAttemptsForSet(
      'profile-answers',
      'set_store_answers',
      USER_A,
    );
    expect(attempts.map((item) => item.id)).toEqual(['attempt_store_2', 'attempt_store_1']);
    expect(attempts.map((item) => item.questionId)).toEqual(['q2', 'q1']);

    // Another connection never sees the attempts of this one.
    const foreign = await listPracticeAttemptsForSet(
      'profile-foreign',
      'set_store_answers',
      USER_A,
    );
    expect(foreign.map((item) => item.id)).toEqual(['attempt_store_4']);

    // Another set of the same connection is a separate bucket.
    const otherSet = await listPracticeAttemptsForSet('profile-answers', 'set_store_other', USER_A);
    expect(otherSet.map((item) => item.id)).toEqual(['attempt_store_3']);
  });

  it('lists the attempts of one connection only', async () => {
    const attempts = await listPracticeAttempts('profile-answers', 100, USER_A);
    expect(attempts.every((item) => item.profileId === 'profile-answers')).toBe(true);
    expect(attempts.some((item) => item.id === 'attempt_store_4')).toBe(false);
  });

  it('deduplicates by unique attempt identity, never a broad question key', async () => {
    const profile = 'profile-attempt-identity';
    const setId = 'set-attempt-identity';
    const base = attempt('attempt-identity-a', profile, setId, 'q1', '2026-02-01T00:00:00Z');
    const newer = {
      ...base,
      id: 'attempt-identity-b',
      createdAt: '2026-02-02T00:00:00Z',
      userSql: 'SELECT 2',
    };
    const replacement = { ...base, userSql: 'SELECT 3' };

    await Promise.all([
      addPracticeAttempt(base),
      addPracticeAttempt(newer),
      addPracticeAttempt(replacement),
    ]);

    const stored = await listPracticeAttemptsForSet(profile, setId, USER_A);
    expect(stored.filter((item) => item.id === base.id)).toHaveLength(1);
    expect(stored.find((item) => item.id === base.id)?.userSql).toBe('SELECT 3');
    expect(stored.find((item) => item.id === newer.id)?.userSql).toBe('SELECT 2');
  });

  it('clears only the caller account on a shared profile', async () => {
    const profile = 'profile-clear-account';
    const setId = 'set-clear-account';
    await Promise.all([
      addPracticeAttempt(
        attempt('attempt-clear-a', profile, setId, 'q1', '2026-03-01T00:00:00Z', USER_A),
      ),
      addPracticeAttempt(
        attempt('attempt-clear-b', profile, setId, 'q1', '2026-03-01T00:00:01Z', USER_B),
      ),
    ]);

    await clearPracticeAttempts(profile, USER_A);

    expect(await listPracticeAttemptsForSet(profile, setId, USER_A)).toHaveLength(0);
    expect(
      (await listPracticeAttemptsForSet(profile, setId, USER_B)).map((item) => item.id),
    ).toEqual(['attempt-clear-b']);
  });

  it('applies set retention per account so A cannot evict B', async () => {
    const profile = 'profile-set-retention';
    const protectedSet = practiceSet('set-retention-b', profile, USER_B);
    await savePracticeSet(protectedSet);
    for (let index = 0; index <= PRACTICE_RETENTION.setsPerUser; index += 1) {
      await savePracticeSet(practiceSet(`set-retention-a-${index}`, profile, USER_A));
    }

    expect((await listPracticeSets(profile, 50, USER_B)).map((item) => item.id)).toContain(
      protectedSet.id,
    );
    expect(await listPracticeSets(profile, 50, USER_A)).toHaveLength(
      PRACTICE_RETENTION.setsPerUser,
    );
  });

  it('applies attempt retention per account so A cannot evict B', async () => {
    const profile = 'profile-attempt-retention';
    const setId = 'set-attempt-retention';
    const protectedAttempt = attempt(
      'attempt-retention-b',
      profile,
      setId,
      'q-b',
      '2026-04-01T00:00:00Z',
      USER_B,
    );
    const newestFirst = [
      ...Array.from({ length: PRACTICE_RETENTION.attemptsPerUser + 1 }, (_, index) =>
        attempt(
          `attempt-retention-a-${index}`,
          profile,
          setId,
          `q-a-${index}`,
          new Date(1_800_000_000_000 + index).toISOString(),
          USER_A,
        ),
      ),
      protectedAttempt,
    ];

    const retained = retainPracticeItemsForUser(
      newestFirst,
      USER_A,
      PRACTICE_RETENTION.attemptsPerUser,
    );
    expect(retained.filter((item) => item.userId === USER_A)).toHaveLength(
      PRACTICE_RETENTION.attemptsPerUser,
    );
    expect(retained.find((item) => item.id === protectedAttempt.id)).toBe(protectedAttempt);
    expect(retained.some((item) => item.id === 'attempt-retention-a-1500')).toBe(false);
  });

  it('deletes every practice artifact for A while preserving B', async () => {
    const profile = 'profile-account-delete';
    const setA = practiceSet('set-account-delete-a', profile, USER_A);
    const setB = practiceSet('set-account-delete-b', profile, USER_B);
    await Promise.all([savePracticeSet(setA), savePracticeSet(setB)]);
    await Promise.all([
      addPracticeAttempt(
        attempt(
          'attempt-account-delete-a',
          profile,
          setA.id,
          'q-a',
          '2026-06-01T00:00:00Z',
          USER_A,
        ),
      ),
      addPracticeAttempt(
        attempt(
          'attempt-account-delete-b',
          profile,
          setB.id,
          'q-b',
          '2026-06-01T00:00:01Z',
          USER_B,
        ),
      ),
      recordPracticeReviewOutcome({
        userId: USER_A,
        profileId: profile,
        setId: setA.id,
        questionId: setA.questions[0]?.id ?? 'q-a',
        verdict: 'incorrect',
        topics: ['select'],
        difficulty: 'medium',
        attemptedAt: '2026-06-01T00:00:00Z',
      }),
      recordPracticeReviewOutcome({
        userId: USER_B,
        profileId: profile,
        setId: setB.id,
        questionId: 'q-b',
        verdict: 'incorrect',
        topics: ['select'],
        difficulty: 'medium',
        attemptedAt: '2026-06-01T00:00:01Z',
      }),
      setPracticeDailyEntry(USER_A, profile, { date: '2026-06-01', setId: setA.id }),
      setPracticeDailyEntry(USER_B, profile, { date: '2026-06-01', setId: setB.id }),
    ]);

    await deletePracticeDataForUser(USER_A);

    expect(await listPracticeSets(profile, 50, USER_A)).toEqual([]);
    expect(await listPracticeAttemptsForSet(profile, setA.id, USER_A)).toEqual([]);
    expect(await listDuePracticeReviewItems(USER_A, profile, new Date('2026-06-03'))).toEqual([]);
    expect(await getPracticeDailyEntry(USER_A, profile)).toBeNull();
    expect(await removePracticeReviewItem(USER_A, profile, setA.id, 'q-a')).toBe(false);

    expect((await listPracticeSets(profile, 50, USER_B)).map((set) => set.id)).toContain(setB.id);
    expect(
      (await listPracticeAttemptsForSet(profile, setB.id, USER_B)).map((item) => item.id),
    ).toContain('attempt-account-delete-b');
    expect(await getPracticeDailyEntry(USER_B, profile)).toEqual({
      date: '2026-06-01',
      setId: setB.id,
    });
    await expect(getPracticeSet(setB.id)).resolves.toMatchObject({ userId: USER_B });
  });

  it('clears the attempts of one connection only', async () => {
    const profile = 'profile-clear-connection';
    const foreignProfile = 'profile-clear-connection-foreign';
    const setId = 'set-clear-connection';
    await Promise.all([
      addPracticeAttempt(
        attempt('attempt-clear-connection', profile, setId, 'q1', '2026-05-01T00:00:00Z'),
      ),
      addPracticeAttempt(
        attempt(
          'attempt-clear-connection-foreign',
          foreignProfile,
          setId,
          'q1',
          '2026-05-02T00:00:00Z',
        ),
      ),
    ]);

    await clearPracticeAttempts(profile, USER_A);
    expect(await listPracticeAttemptsForSet(profile, setId, USER_A)).toHaveLength(0);
    expect(
      (await listPracticeAttemptsForSet(foreignProfile, setId, USER_A)).map((item) => item.id),
    ).toEqual(['attempt-clear-connection-foreign']);
  });
});
