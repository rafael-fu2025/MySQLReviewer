import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import type { AiProvider, SchemaSnapshot, ServerInfo } from '../shared/types';
import { AppError } from '../server/errors';

/**
 * Regression tests for the findings that were left over after the 2026-10-27
 * security remediation:
 *
 * - F-26 / D-08: the write unlock belongs to one user, but seven call sites
 *   still asked for the profile-wide grant.
 * - F-14: one malformed field of one finding used to discard the whole review.
 * - F-15: the number of findings the provider sends was unbounded.
 * - F-38: a schema read that failed used to look like an empty schema.
 * - F-13: a repair round trip is a second bill; it has to be observable,
 *   cancellable, and it must not resend the schema and the SQL.
 * - F-36: the practice questions were stored without a bound.
 *
 * Every database and provider call is faked, so the suite needs neither a live
 * MySQL server nor a live LLM provider.
 */

const h = vi.hoisted(() => ({
  conn: null as { threadId: number; query: unknown } | null,
  calls: [] as { sql: string }[],
  history: [] as { sql: string }[],
  attempts: [] as unknown[],
  server: {
    flavor: 'mysql',
    version: '8.0.36',
    versionComment: 'MySQL Community Server - GPL',
    uptimeSeconds: 10,
    sqlMode: 'STRICT_TRANS_TABLES',
    currentDatabase: null,
  },
  settings: {
    theme: 'dark',
    rowLimit: 1000,
    queryTimeoutMs: 30_000,
    cellMaxChars: 16_384,
    liveLint: true,
    includeSchemaByDefault: true,
    aiContextChars: 24_000,
    defaultAiProviderId: null,
    historyLimit: 500,
    showHints: true,
    maskSensitiveColumns: true,
  },
  completeCalls: [] as {
    messages: { role: string; content: string }[];
    options: { signal?: AbortSignal };
  }[],
  streamCalls: [] as { options: { signal?: AbortSignal } }[],
  providerAnswers: [] as string[],
  streamError: null as Error | null,
  schemaError: null as Error | null,
}));

vi.mock('../server/db/manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/manager')>();
  return {
    ...actual,
    getCachedServerInfo: () => h.server as unknown as ServerInfo,
    connectProfile: async () => h.server as unknown as ServerInfo,
    getPool: async () =>
      ({
        getConnection: async () => ({
          query: async () => [[], []],
          release: () => undefined,
        }),
      }) as unknown as Pool,
    withConnection: async (_profileId: string, fn: (conn: unknown) => Promise<unknown>) =>
      fn(h.conn),
  };
});

vi.mock('../server/db/dialect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/dialect')>();
  return {
    ...actual,
    applyQueryGuards: (async () => ({
      cleanup: async () => undefined,
    })) as unknown as typeof actual.applyQueryGuards,
    startStatementWatchdog: (() => ({
      cancel: () => undefined,
    })) as unknown as typeof actual.startStatementWatchdog,
  };
});

vi.mock('../server/db/scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/scope')>();
  return {
    ...actual,
    assertSqlScope: async () => undefined,
    assertDatabaseAllowed: async () => undefined,
  };
});

vi.mock('../server/store/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/settings')>();
  return { ...actual, getSettings: async () => h.settings as never };
});

vi.mock('../server/store/profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/profiles')>();
  return {
    ...actual,
    getStoredProfile: (async () => ({
      id: 'p1',
      database: 'shop',
    })) as unknown as typeof actual.getStoredProfile,
  };
});

vi.mock('../server/store/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/history')>();
  return {
    ...actual,
    addHistory: (async (input: { sql: string }) => {
      h.history.push({ sql: input.sql });
      return { ...input, id: 'entry-1' } as never;
    }) as unknown as typeof actual.addHistory,
  };
});

vi.mock('../server/db/introspection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/introspection')>();
  return {
    ...actual,
    getSchemaSnapshot: (async () => {
      if (h.schemaError) throw h.schemaError;
      return {
        database: 'shop',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        tables: [
          {
            database: 'shop',
            name: 'secret_orders',
            type: 'BASE TABLE',
            engine: 'InnoDB',
            rowsEstimate: 10,
            dataBytes: 1,
            indexBytes: 1,
            dataFreeBytes: 0,
            collation: 'utf8mb4_general_ci',
            charset: 'utf8mb4',
            comment: '',
            columns: [
              {
                name: 'id',
                columnType: 'int',
                dataType: 'int',
                nullable: false,
                key: 'PRI',
                extra: '',
                defaultValue: null,
              },
            ],
            indexes: [],
            foreignKeys: [],
            triggers: [],
            checks: [],
            partitions: [],
            createSql: null,
          },
        ],
      } as unknown as SchemaSnapshot;
    }) as unknown as typeof actual.getSchemaSnapshot,
  };
});

vi.mock('../server/ai/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/ai/index')>();
  return {
    ...actual,
    complete: vi.fn(
      async (
        _provider: AiProvider,
        _apiKey: string | null,
        messages: { role: string; content: string }[],
        options: { signal?: AbortSignal } = {},
      ) => {
        h.completeCalls.push({ messages, options });
        return { text: h.providerAnswers.shift() ?? '', usage: null };
      },
    ),
    stream: vi.fn(
      async (
        _provider: AiProvider,
        _apiKey: string | null,
        _messages: { role: string; content: string }[],
        handlers: { onDelta: (text: string) => void },
        options: { signal?: AbortSignal } = {},
      ) => {
        h.streamCalls.push({ options });
        if (h.streamError) throw h.streamError;
        const text = h.providerAnswers.shift() ?? '';
        if (text) handlers.onDelta(text);
        return { text, usage: null };
      },
    ),
  };
});

vi.mock('../server/store/practice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/practice')>();
  return {
    ...actual,
    getPracticeSet: (async () => ({
      id: 'set-1',
      profileId: 'p1',
      createdAt: '2026-01-01T00:00:00.000Z',
      database: 'shop',
      providerId: 'prov-1',
      model: 'test-model',
      summary: 'A set.',
      questions: [
        {
          id: 'q1',
          type: 'concept',
          title: 'Explain the join',
          scenario: 'What does this join do?',
          difficulty: 'easy',
          topics: ['select'],
          schemaTables: ['secret_orders'],
          brokenSql: null,
          referenceSql: null,
          expectedResult: null,
          orderMatters: false,
          hints: ['Think about the key'],
          estimatedMinutes: 5,
          execute: false,
        },
      ],
    })) as unknown as typeof actual.getPracticeSet,
    listPracticeAttemptsForSet:
      (async () => []) as unknown as typeof actual.listPracticeAttemptsForSet,
    addPracticeAttempt: (async (attempt: unknown) => {
      h.attempts.push(attempt);
      return attempt as never;
    }) as unknown as typeof actual.addPracticeAttempt,
    savePracticeSet: (async (set: unknown) =>
      set as never) as unknown as typeof actual.savePracticeSet,
  };
});

import { unlockWrites, lockWrites } from '../server/db/manager';
import { executeQuery } from '../server/db/query';
import { runExplain } from '../server/db/explain';
import { getTableData } from '../server/db/introspection';
import { explorerRouter } from '../server/routes/explorer';
import { MAX_AI_FINDINGS, parseAiReview, runAiReview, schemaTextFor } from '../server/ai/analyze';
import {
  boundPracticeQuestion,
  buildPracticeRepairMessages,
  evaluatePractice,
} from '../server/ai/practice';

const provider: AiProvider = {
  id: 'prov-1',
  name: 'Test provider',
  type: 'openai',
  baseUrl: 'https://provider.test',
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
  temperature: 0.2,
  maxTokens: 4_096,
  streaming: false,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

type QueryHandler = (sql: string, values?: unknown[]) => unknown;

function fakeConn(handler: QueryHandler): { threadId: number; query: unknown } {
  return {
    threadId: 7,
    query: vi.fn(async (arg: unknown, values?: unknown[]) => {
      const isString = typeof arg === 'string';
      const sql = isString ? arg : String((arg as { sql: string }).sql);
      h.calls.push({ sql });
      return handler(sql, values);
    }),
  };
}

/** A connection that answers the metadata and the data query of the table path. */
function tableConn(): { threadId: number; query: unknown } {
  return fakeConn((sql) => {
    if (sql.includes('information_schema.COLUMNS')) {
      return [[{ COLUMN_NAME: 'id' }], []];
    }
    if (sql.startsWith('SELECT * FROM')) {
      return [[['1']], [{ name: 'id', orgName: 'id', type: 253, flags: 0 }]];
    }
    return [[], []];
  });
}

function resetState(): void {
  h.conn = tableConn();
  h.calls = [];
  h.history = [];
  h.attempts = [];
  h.completeCalls = [];
  h.streamCalls = [];
  h.providerAnswers = [];
  h.streamError = null;
  h.schemaError = null;
  lockWrites('p1', 'u-member');
  lockWrites('p1', 'u-other');
  lockWrites('p1', 'u-admin');
}

const validReview = JSON.stringify({
  verdict: 'fail',
  score: 42,
  summary: 'The statement misses an index.',
  findings: [
    {
      severity: 'high',
      category: 'performance',
      title: 'Missing index',
      detail: 'The filter cannot use an index.',
      recommendation: 'Add an index.',
      line: 12,
      table: 'secret_orders',
    },
  ],
  rewrite: { sql: 'SELECT 1', explanation: 'Simpler.' },
});

/* ------------------------------------------------------------------ */
/* F-26 / D-08 — the write unlock belongs to one user                   */
/* ------------------------------------------------------------------ */

describe('F-26 / D-08 — the unlock call sites name the user', () => {
  it('lets the user who unlocked writes through and keeps the others locked', async () => {
    resetState();
    // The member unlocks writes for themselves, not for the whole profile.
    unlockWrites('p1', 'u-member', 'UNLOCK WRITES');

    await expect(
      executeQuery('p1', "UPDATE users SET name = 'x' WHERE id = 1", {
        userId: 'u-member',
        database: 'shop',
      }),
    ).resolves.toBeDefined();

    await expect(
      executeQuery('p1', "UPDATE users SET name = 'x' WHERE id = 1", {
        userId: 'u-other',
        database: 'shop',
      }),
    ).rejects.toMatchObject({ code: 'WRITE_LOCKED' });
  });

  it('keeps the table-data reveal gate bound to the same user', async () => {
    resetState();
    unlockWrites('p1', 'u-member', 'UNLOCK WRITES');

    await expect(
      getTableData('p1', 'shop', 'users', { revealSensitive: true, userId: 'u-member' }),
    ).resolves.toBeDefined();

    await expect(
      getTableData('p1', 'shop', 'users', { revealSensitive: true, userId: 'u-other' }),
    ).rejects.toMatchObject({ code: 'REVEAL_LOCKED' });
  });

  it('keeps the EXPLAIN ANALYZE gate bound to the same user', async () => {
    resetState();
    unlockWrites('p1', 'u-member', 'UNLOCK WRITES');
    // A locking read takes row locks, so EXPLAIN ANALYZE has to unlock first.
    const lockingRead = 'SELECT id FROM secret_orders FOR UPDATE';

    // The unlocked user passes the gate: the failure, if any, comes later and
    // is not the unlock gate.
    const unlockedError = await runExplain('p1', lockingRead, 'shop', {
      analyze: true,
      userId: 'u-member',
    }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(unlockedError?.code ?? null).not.toBe('WRITE_LOCKED');

    await expect(
      runExplain('p1', lockingRead, 'shop', {
        analyze: true,
        userId: 'u-other',
      }),
    ).rejects.toMatchObject({ code: 'WRITE_LOCKED' });
  });

  it('checks the route-level unlock with the signed-in user', async () => {
    resetState();
    unlockWrites('p1', 'u-member', 'UNLOCK WRITES');

    const router = explorerRouter as unknown as {
      stack: { route?: { path: string; stack: { handle: unknown }[] } }[];
    };
    const layer = router.stack.find(
      (entry) => entry.route?.path === '/:profileId/databases/:database/tables/:table/data',
    );
    const handler = layer?.route?.stack[0]?.handle as (
      req: unknown,
      res: unknown,
      next: (error?: unknown) => void,
    ) => void;
    expect(handler).toBeTypeOf('function');

    const run = async (userId: string): Promise<unknown[]> => {
      const errors: unknown[] = [];
      handler(
        {
          params: { profileId: 'p1', database: 'shop', table: 'users' },
          body: { revealSensitive: true },
          user: { id: userId, username: 'member', role: 'member' },
        },
        { json: () => undefined },
        (error?: unknown) => {
          errors.push(error);
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      return errors;
    };

    expect(await run('u-member')).toHaveLength(0);
    const otherErrors = await run('u-other');
    expect(otherErrors).toHaveLength(1);
    expect(otherErrors[0]).toMatchObject({ code: 'REVEAL_LOCKED' });
  });
});

/* ------------------------------------------------------------------ */
/* F-14 — one malformed field must not discard the whole review        */
/* ------------------------------------------------------------------ */

describe('F-14 — a single malformed item does not lose the review', () => {
  it('keeps the valid findings when one finding has a string line and the rewrite has no sql', () => {
    const parsed = parseAiReview(
      JSON.stringify({
        verdict: 'fail',
        score: 42,
        summary: 'Two things to fix.',
        findings: [
          { severity: 'high', title: 'Missing index', detail: 'No index.', line: 12 },
          {
            severity: 'high',
            title: 'Quoted line',
            detail: 'The model quoted the line.',
            line: '34',
          },
        ],
        rewrite: { explanation: 'The model forgot the SQL.' },
      }),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.findings).toHaveLength(2);
    expect(parsed?.findings[1].line).toBe(34);
    expect(parsed?.rewrite).toBeNull();
    expect(parsed?.verdict).toBe('fail');
  });

  it('still rejects an answer that is not a review at all', () => {
    expect(parseAiReview(JSON.stringify({ hello: 'world' }))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* F-15 — the number of findings is capped                              */
/* ------------------------------------------------------------------ */

describe('F-15 — the number of findings is capped', () => {
  it('keeps the cap and reports that the answer was truncated', () => {
    const findings = Array.from({ length: MAX_AI_FINDINGS + 25 }, (_, index) => ({
      severity: 'low',
      title: `Finding ${index}`,
      detail: 'Detail.',
    }));
    const parsed = parseAiReview(JSON.stringify({ verdict: 'warn', findings }));

    expect(parsed).not.toBeNull();
    expect(parsed?.findings).toHaveLength(MAX_AI_FINDINGS);
    expect(parsed?.findingsTruncated).toBe(true);
    expect(parsed?.findingsTotal).toBe(MAX_AI_FINDINGS + 25);
  });
});

/* ------------------------------------------------------------------ */
/* F-38 — a failed schema read is not an empty schema                  */
/* ------------------------------------------------------------------ */

describe('F-38 — a failed schema read is visible', () => {
  it('reports the failure instead of returning an empty schema', async () => {
    resetState();
    h.schemaError = new Error('the schema could not be read');

    const schema = await schemaTextFor('p1', 'shop', 'SELECT 1');
    expect(schema.text).toBe('');
    expect(schema.error).toContain('the schema could not be read');
  });

  it('warns in the review that the schema could not be read', async () => {
    resetState();
    h.schemaError = new Error('the schema could not be read');
    h.providerAnswers.push(validReview);

    const result = await runAiReview(
      {
        profileId: 'p1',
        database: 'shop',
        sql: 'SELECT * FROM secret_orders',
        providerId: provider.id,
        findings: [],
      },
      provider,
      null,
      () => undefined,
    );

    expect(result.review.warnings?.join(' ')).toContain('schema could not be read');
  });
});

/* ------------------------------------------------------------------ */
/* F-13 — a retry is a second bill: observable, cancellable, small      */
/* ------------------------------------------------------------------ */

describe('F-13 — the repair round trip is observable and does not resend the context', () => {
  it('reports the repair and keeps the schema and the SQL out of the repair request', async () => {
    resetState();
    h.providerAnswers.push('this is not json at all', validReview);

    const result = await runAiReview(
      {
        profileId: 'p1',
        database: 'shop',
        sql: 'SELECT * FROM secret_orders',
        providerId: provider.id,
        findings: [],
      },
      provider,
      null,
      () => undefined,
    );

    expect(h.completeCalls).toHaveLength(2);
    expect(result.review.repairAttempted).toBe(true);
    expect(result.review.warnings?.join(' ')).toContain('billed again');

    const repair = h.completeCalls[1].messages.map((message) => message.content).join('\n');
    expect(repair).not.toContain('secret_orders');
    expect(repair).not.toContain('SELECT * FROM secret_orders');
  });

  it('does not spend a second call when the request was cancelled', async () => {
    resetState();
    h.providerAnswers.push('this is not json at all');
    const controller = new AbortController();
    controller.abort();

    await runAiReview(
      {
        profileId: 'p1',
        database: 'shop',
        sql: 'SELECT * FROM secret_orders',
        providerId: provider.id,
        findings: [],
      },
      provider,
      null,
      () => undefined,
      controller.signal,
    );

    expect(h.completeCalls).toHaveLength(1);
  });

  it('does not fall back to a second call when the provider cancelled the request', async () => {
    resetState();
    h.streamError = new AppError('AI_CANCELLED', 'The AI request was cancelled.', 499);
    const streamingProvider = { ...provider, streaming: true };

    await expect(
      runAiReview(
        {
          profileId: 'p1',
          database: 'shop',
          sql: 'SELECT * FROM secret_orders',
          providerId: provider.id,
          findings: [],
        },
        streamingProvider,
        null,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    expect(h.completeCalls).toHaveLength(0);
  });

  it('keeps the practice repair request free of the schema and the SQL', async () => {
    resetState();
    h.providerAnswers.push('not json', 'still not json');

    const evaluation = await evaluatePractice({
      profileId: 'p1',
      setId: 'set-1',
      questionId: 'q1',
      userAnswer: 'It joins on the id.',
      includeAi: true,
      provider,
      apiKey: 'key',
    });

    expect(evaluation.aiRepairAttempted).toBe(true);
    expect(h.completeCalls).toHaveLength(2);
    const repair = h.completeCalls[1].messages.map((message) => message.content).join('\n');
    expect(repair).not.toContain('secret_orders');
  });

  it('builds a practice repair request without the original context', () => {
    const messages = [
      { role: 'system' as const, content: 'Return JSON.' },
      { role: 'user' as const, content: 'SCHEMA: secret_orders\nSQL: SELECT 1' },
    ];
    const repair = buildPracticeRepairMessages(messages, 'not json', 'grading result');
    expect(repair).toHaveLength(3);
    expect(repair.map((message) => message.content).join('\n')).not.toContain('secret_orders');
  });
});

/* ------------------------------------------------------------------ */
/* F-36 — the stored practice question is bounded                       */
/* ------------------------------------------------------------------ */

describe('F-36 — the stored practice question is bounded', () => {
  it('bounds every free-text field and every list of a generated question', () => {
    const bounded = boundPracticeQuestion({
      title: 't'.repeat(5_000),
      scenario: 's'.repeat(50_000),
      brokenSql: `SELECT 1;${'x'.repeat(100_000)}`,
      referenceSql: `SELECT 2;${'y'.repeat(100_000)}`,
      expectedResult: 'e'.repeat(50_000),
      hints: Array.from({ length: 40 }, () => 'h'.repeat(5_000)),
      topics: Array.from({ length: 40 }, () => 't'.repeat(200)),
      tables: Array.from({ length: 40 }, () => 'b'.repeat(300)),
    });

    expect(bounded.title.length).toBeLessThanOrEqual(181);
    expect(bounded.scenario.length).toBeLessThanOrEqual(6_001);
    expect((bounded.brokenSql ?? '').length).toBeLessThanOrEqual(20_000);
    expect((bounded.referenceSql ?? '').length).toBeLessThanOrEqual(20_000);
    expect((bounded.expectedResult ?? '').length).toBeLessThanOrEqual(6_001);
    expect(bounded.hints.length).toBeLessThanOrEqual(10);
    for (const hint of bounded.hints) expect(hint.length).toBeLessThanOrEqual(2_000);
    expect(bounded.topics.length).toBeLessThanOrEqual(14);
    for (const topic of bounded.topics) expect(topic.length).toBeLessThanOrEqual(64);
    expect(bounded.tables.length).toBeLessThanOrEqual(20);
    for (const table of bounded.tables) expect(table.length).toBeLessThanOrEqual(128);
  });
});

beforeEach(() => {
  resetState();
});
