import { describe, expect, it } from 'vitest';
import type { PracticeAttempt, PracticeSet } from '../shared/types';
import {
  addPracticeAttempt,
  clearPracticeAttempts,
  getPracticeSet,
  listPracticeAttempts,
  listPracticeAttemptsForSet,
  listPracticeSets,
  savePracticeSet,
} from '../server/store/practice';

function practiceSet(id: string, profileId: string): PracticeSet {
  return {
    id,
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
): PracticeAttempt {
  return {
    id,
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
  it('keeps the generated sets per connection', async () => {
    await savePracticeSet(practiceSet('set_store_a', 'profile-a'));
    await savePracticeSet(practiceSet('set_store_b', 'profile-b'));

    const forA = await listPracticeSets('profile-a');
    const forB = await listPracticeSets('profile-b');
    expect(forA.map((item) => item.id)).toContain('set_store_a');
    expect(forA.map((item) => item.id)).not.toContain('set_store_b');
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

    const attempts = await listPracticeAttemptsForSet('profile-answers', 'set_store_answers');
    expect(attempts.map((item) => item.id)).toEqual(['attempt_store_2', 'attempt_store_1']);
    expect(attempts.map((item) => item.questionId)).toEqual(['q2', 'q1']);

    // Another connection never sees the attempts of this one.
    const foreign = await listPracticeAttemptsForSet('profile-foreign', 'set_store_answers');
    expect(foreign.map((item) => item.id)).toEqual(['attempt_store_4']);

    // Another set of the same connection is a separate bucket.
    const otherSet = await listPracticeAttemptsForSet('profile-answers', 'set_store_other');
    expect(otherSet.map((item) => item.id)).toEqual(['attempt_store_3']);
  });

  it('lists the attempts of one connection only', async () => {
    const attempts = await listPracticeAttempts('profile-answers', 100);
    expect(attempts.every((item) => item.profileId === 'profile-answers')).toBe(true);
    expect(attempts.some((item) => item.id === 'attempt_store_4')).toBe(false);
  });

  it('clears the attempts of one connection only', async () => {
    await clearPracticeAttempts('profile-answers');
    expect(await listPracticeAttemptsForSet('profile-answers', 'set_store_answers')).toHaveLength(
      0,
    );
    expect(
      (await listPracticeAttemptsForSet('profile-foreign', 'set_store_answers')).map(
        (item) => item.id,
      ),
    ).toEqual(['attempt_store_4']);
    // The generated sets survive a cleared attempt history.
    expect((await listPracticeSets('profile-answers')).map((item) => item.id)).toContain(
      'set_store_answers',
    );
  });
});
