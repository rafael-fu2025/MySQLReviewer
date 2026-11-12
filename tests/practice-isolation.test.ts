import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AiProvider,
  PracticeAttempt,
  PracticeGenerateRequest,
  PracticeQuestion,
  PracticeSet,
} from '../shared/types';

const h = vi.hoisted(() => ({
  assertDatabaseAllowed: vi.fn(
    async (_profileId: string, _database: string, _scope?: { allowed: string[] }) => undefined,
  ),
  complete: vi.fn(async () => ({
    text: JSON.stringify({
      summary: 'Generated for one account.',
      questions: [
        {
          type: 'concept',
          title: 'Explain a covering index',
          scenario: 'Explain when a covering index avoids a table lookup.',
          difficulty: 'easy',
          topics: ['indexes'],
          tables: [],
          expectedResult: 'A concise explanation.',
          hints: ['Think about columns available in the secondary index.'],
          estimatedMinutes: 5,
          execute: false,
        },
      ],
    }),
    usage: null,
  })),
}));

vi.mock('../server/db/scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/scope')>();
  return {
    ...actual,
    assertDatabaseAllowed: h.assertDatabaseAllowed,
    assertSqlScope: vi.fn(async () => undefined),
  };
});

vi.mock('../server/db/manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/manager')>();
  return { ...actual, getCachedServerInfo: vi.fn(() => null) };
});

vi.mock('../server/db/introspection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/introspection')>();
  return {
    ...actual,
    getSchemaSnapshot: vi.fn(async (_profileId: string, database: string) => ({
      database,
      tables: [],
      fetchedAt: '2026-11-12T00:00:00.000Z',
    })),
    getDatabaseObjects: vi.fn(async () => ({
      tables: [],
      views: [],
      routines: [],
      triggers: [],
      events: [],
    })),
  };
});

vi.mock('../server/store/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/settings')>();
  return {
    ...actual,
    getSettings: vi.fn(async () => ({
      theme: 'dark',
      rowLimit: 1_000,
      queryTimeoutMs: 30_000,
      cellMaxChars: 16_384,
      liveLint: true,
      includeSchemaByDefault: true,
      aiContextChars: 24_000,
      defaultAiProviderId: null,
      historyLimit: 500,
      showHints: true,
      maskSensitiveColumns: true,
    })),
  };
});

vi.mock('../server/ai/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/ai/index')>();
  return {
    ...actual,
    complete: h.complete,
    stream: vi.fn(),
  };
});

import { evaluatePractice, generatePracticeSet } from '../server/ai/practice';
import { DATA_DIR } from '../server/config';
import {
  addPracticeAttempt,
  getPracticeDailyEntry,
  listDuePracticeReviewItems,
  listPracticeAttemptsForSet,
  listPracticeSets,
  savePracticeSet,
  setPracticeDailyEntry,
} from '../server/store/practice';

const USER_A = 'practice-isolation-a';
const USER_B = 'practice-isolation-b';

const provider: AiProvider = {
  id: 'practice-isolation-provider',
  name: 'Practice isolation provider',
  type: 'openai',
  baseUrl: 'https://provider.invalid',
  chatPath: '/v1/chat/completions',
  modelsPath: '/v1/models',
  model: 'test-model',
  models: ['test-model'],
  hasApiKey: false,
  apiKeyHint: null,
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  headers: {},
  extraBody: {},
  temperature: 0,
  maxTokens: 1_024,
  streaming: false,
  isDefault: true,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
};

function conceptQuestion(id = 'q-isolation'): PracticeQuestion {
  return {
    id,
    type: 'concept',
    title: 'Explain a covering index',
    scenario: 'Explain why all projected columns in an index can avoid a table lookup.',
    difficulty: 'easy',
    topics: ['indexes'],
    schemaTables: [],
    brokenSql: null,
    referenceSql: null,
    expectedResult: 'A covering index contains every needed column.',
    orderMatters: false,
    hints: [],
    estimatedMinutes: 5,
    execute: false,
  };
}

function ownedSet(id: string, userId: string, profileId: string): PracticeSet {
  return {
    id,
    userId,
    profileId,
    createdAt: '2026-11-12T00:00:00.000Z',
    database: 'shop',
    providerId: provider.id,
    model: provider.model,
    summary: 'Isolation set',
    questions: [conceptQuestion()],
  };
}

function recordedAttempt(
  id: string,
  userId: string,
  set: PracticeSet,
  userAnswer: string,
): PracticeAttempt {
  return {
    id,
    userId,
    profileId: set.profileId,
    setId: set.id,
    questionId: set.questions[0].id,
    database: set.database,
    topics: ['indexes'],
    difficulty: 'easy',
    userSql: '',
    userAnswer,
    evaluation: {
      questionId: set.questions[0].id,
      executed: false,
      verdict: 'not-executed',
      scores: { correctness: 90, performance: 100, style: 100, overall: 94 },
      summary: `${userId} private grade`,
      strengths: [],
      issues: [],
      nextHint: '',
      comparison: null,
      findings: [],
      explain: null,
      aiFeedback: null,
      referenceSql: `${userId} private reference`,
      userSql: null,
      userAnswer,
      userResult: null,
      referenceResult: null,
    },
    createdAt: '2026-11-12T01:00:00.000Z',
  };
}

beforeEach(() => {
  h.assertDatabaseAllowed.mockClear();
  h.complete.mockClear();
});

describe('PRACTICE multi-user generation ownership', () => {
  it('persists concurrent A/B sets with the owner supplied by each authenticated run', async () => {
    const profileId = 'profile-generation-isolation';
    const request: PracticeGenerateRequest = {
      profileId,
      database: 'shop',
      topics: ['indexes'],
      difficulty: 'easy',
      count: 1,
      providerId: provider.id,
    };

    const [generatedA, generatedB] = await Promise.all([
      generatePracticeSet(request, provider, null, () => undefined, {
        userId: USER_A,
      }),
      generatePracticeSet(request, provider, null, () => undefined, {
        userId: USER_B,
      }),
    ]);

    expect(generatedA.set.userId).toBe(USER_A);
    expect(generatedB.set.userId).toBe(USER_B);
    expect(generatedA.set.id).not.toBe(generatedB.set.id);
    expect((await listPracticeSets(profileId, 20, USER_A)).map((set) => set.id)).toContain(
      generatedA.set.id,
    );
    expect((await listPracticeSets(profileId, 20, USER_A)).map((set) => set.id)).not.toContain(
      generatedB.set.id,
    );
    expect((await listPracticeSets(profileId, 20, USER_B)).map((set) => set.id)).toContain(
      generatedB.set.id,
    );
  });
});

describe('PRACTICE legacy learning-loop isolation', () => {
  it('does not expose legacy profile-only review or daily data to either first caller', async () => {
    const profileId = 'profile-legacy-isolation';
    const set = ownedSet('set-legacy-isolation', USER_A, profileId);
    await savePracticeSet(set);
    const storePath = path.join(DATA_DIR, 'practice.json');
    const file = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
      reviews?: Record<string, unknown[]>;
      daily?: Record<string, unknown>;
    };
    file.reviews = {
      ...(file.reviews ?? {}),
      [profileId]: [
        {
          profileId,
          setId: set.id,
          questionId: set.questions[0].id,
          box: 0,
          dueAt: '2026-01-01T00:00:00.000Z',
          lastVerdict: 'incorrect',
          lastAttemptAt: '2025-12-31T00:00:00.000Z',
          topics: ['indexes'],
          difficulty: 'easy',
        },
      ],
    };
    file.daily = {
      ...(file.daily ?? {}),
      [profileId]: { date: '2026-11-12', setId: set.id },
    };
    fs.writeFileSync(storePath, JSON.stringify(file));

    expect(await listDuePracticeReviewItems(USER_A, profileId)).toHaveLength(0);
    expect(await listDuePracticeReviewItems(USER_B, profileId)).toHaveLength(0);
    expect(await getPracticeDailyEntry(USER_A, profileId)).toBeNull();
    expect(await getPracticeDailyEntry(USER_B, profileId)).toBeNull();

    await setPracticeDailyEntry(USER_A, profileId, { date: '2026-11-12', setId: set.id });
    expect(await getPracticeDailyEntry(USER_A, profileId)).toEqual({
      date: '2026-11-12',
      setId: set.id,
    });
    expect(await getPracticeDailyEntry(USER_B, profileId)).toBeNull();
  });
});

describe('PRACTICE foreign evaluation and duplicate isolation', () => {
  it('grades A while rejecting B before B can reuse its duplicate on A’s set', async () => {
    const profileId = 'profile-evaluation-isolation';
    const set = ownedSet('set-evaluation-isolation', USER_A, profileId);
    const answer = 'The secondary index contains every column the query needs.';
    const setB = ownedSet('set-evaluation-isolation-b', USER_B, profileId);
    await Promise.all([savePracticeSet(set), savePracticeSet(setB)]);
    // B has the same normalized submission on B's own set. Duplicate lookup
    // must stay in B's account and cannot be consulted while B targets A's set.
    await addPracticeAttempt(recordedAttempt('attempt-foreign-duplicate', USER_B, setB, answer));

    const [forA, forB] = await Promise.allSettled([
      evaluatePractice({
        userId: USER_A,
        profileId,
        setId: set.id,
        questionId: set.questions[0].id,
        userAnswer: answer,
      }),
      evaluatePractice({
        userId: USER_B,
        profileId,
        setId: set.id,
        questionId: set.questions[0].id,
        userAnswer: answer,
      }),
    ]);

    expect(forA.status).toBe('fulfilled');
    if (forA.status === 'fulfilled') {
      expect(forA.value.duplicate).not.toBe(true);
      expect(forA.value.summary).not.toContain(USER_B);
    }
    expect(forB.status).toBe('rejected');
    if (forB.status === 'rejected') {
      expect(forB.reason).toMatchObject({ code: 'PRACTICE_SET_FORBIDDEN', status: 403 });
    }
    expect(h.assertDatabaseAllowed).toHaveBeenCalled();
    expect(h.assertDatabaseAllowed.mock.calls.every((call) => call[0] === profileId)).toBe(true);

    const attemptsA = await listPracticeAttemptsForSet(profileId, set.id, USER_A);
    const attemptsB = await listPracticeAttemptsForSet(profileId, setB.id, USER_B);
    expect(attemptsA).toHaveLength(1);
    expect(attemptsA[0].userId).toBe(USER_A);
    expect(attemptsB).toHaveLength(1);
    expect(attemptsB[0].evaluation.summary).toContain(USER_B);

    const duplicateA = await evaluatePractice({
      userId: USER_A,
      profileId,
      setId: set.id,
      questionId: set.questions[0].id,
      userAnswer: answer,
    });
    expect(duplicateA.duplicate).toBe(true);
    expect(await listPracticeAttemptsForSet(profileId, set.id, USER_A)).toHaveLength(1);
  });
});
