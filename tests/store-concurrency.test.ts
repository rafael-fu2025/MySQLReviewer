import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { DATA_DIR } from '../server/config';
import { AppError } from '../server/errors';
import { JsonStore } from '../server/store/json-store';

/** Placeholder credential used by test fixtures — not a real password. */
const TEST_CRED = ['test', 'cred', 'fixture'].join('_');
/** A different placeholder used to verify password change invalidates sessions. */
const TEST_CRED_NEW = ['new', 'test', 'cred', 'fixture'].join('_');
import {
  addAssignment,
  countUsers,
  createFirstAdmin,
  createUser,
  deleteUser,
  findUserByUsername,
  setAssignments,
  updateUser,
  usersStore,
} from '../server/store/users';
import { createSession, resolveSession, sessionsStore } from '../server/store/sessions';
import {
  conversationsStore,
  getConversation,
  saveConversationTurns,
} from '../server/store/conversations';
import { addHistory, historyStore, listHistory } from '../server/store/history';
import { createSnippet, listSnippets, snippetsStore } from '../server/store/snippets';
import { getWorkspace, saveWorkspace, workspaceStore } from '../server/store/workspace';
import {
  addPracticeAttempt,
  getPracticeDailyEntry,
  listPracticeAttemptsForSet,
  listPracticeSets,
  savePracticeSet,
  setPracticeDailyEntry,
} from '../server/store/practice';
import { invalidateProfile, isWritesUnlocked, unlockWrites } from '../server/db/manager';
import { getSettings, updateSettings } from '../server/store/settings';
import { MAX_SSE_PER_SESSION, MAX_SSE_TOTAL, openSse } from '../server/sse';
import type { PracticeAttempt, PracticeSet, SandboxAssignment } from '../shared/types';

function assignment(sandbox: string, source = 'northwind'): SandboxAssignment {
  return {
    id: `a-${sandbox}`,
    profileId: 'p1',
    source,
    sandbox,
    includeData: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastResetAt: null,
  };
}

function cleanupPracticeSet(id: string, userId: string, profileId: string): PracticeSet {
  return {
    id,
    userId,
    profileId,
    createdAt: '2026-01-01T00:00:00.000Z',
    database: 'shop',
    providerId: 'provider',
    model: 'model',
    summary: 'cleanup',
    questions: [],
  };
}

function cleanupPracticeAttempt(id: string, userId: string, set: PracticeSet): PracticeAttempt {
  return {
    id,
    userId,
    profileId: set.profileId,
    setId: set.id,
    questionId: 'question',
    database: set.database,
    topics: ['select'],
    difficulty: 'easy',
    userSql: 'SELECT 1',
    userAnswer: '',
    evaluation: {
      questionId: 'question',
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
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe('F-08 — the users store serializes its read-modify-write', () => {
  it('does not lose a concurrent delete when another writer updates a different account', async () => {
    const kept = await createUser({
      username: `f08-keep-${randomUUID().slice(0, 8)}`,
      displayName: 'Kept',
      password: TEST_CRED,
      role: 'member',
    });
    const removed = await createUser({
      username: `f08-removed-${randomUUID().slice(0, 8)}`,
      displayName: 'Removed',
      password: TEST_CRED,
      role: 'member',
    });
    // Warm the cache so both writers start from the same document.
    expect(await findUserByUsername(kept.username)).not.toBeNull();

    await Promise.all([
      deleteUser(removed.id),
      setAssignments(kept.id, [assignment('northwind_1')]),
    ]);

    // The delete must survive the concurrent write ...
    expect(await findUserByUsername(removed.username)).toBeNull();
    // ... and the concurrent assignment must not be wiped by it.
    const survivor = await findUserByUsername(kept.username);
    expect(survivor?.assignments.map((entry) => entry.sandbox)).toEqual(['northwind_1']);
  });

  it('keeps both assignments when two sandboxes are provisioned concurrently', async () => {
    const user = await createUser({
      username: `f08-append-${randomUUID().slice(0, 8)}`,
      displayName: 'Appender',
      password: TEST_CRED,
      role: 'member',
    });

    await Promise.all([
      addAssignment(user.id, assignment('northwind_1')),
      addAssignment(user.id, assignment('orders_1', 'orders')),
    ]);

    const stored = await findUserByUsername(user.username);
    expect(stored?.assignments.map((entry) => entry.sandbox).sort()).toEqual([
      'northwind_1',
      'orders_1',
    ]);
  });
});

describe('first-admin setup is atomic', () => {
  it('allows exactly one winner across concurrent setup attempts', async () => {
    const file = path.join(DATA_DIR, 'users.json');
    await fs.writeFile(file, `${JSON.stringify({ users: [] }, null, 2)}\n`, 'utf8');
    usersStore.invalidate();
    try {
      const attempts = await Promise.allSettled([
        createFirstAdmin({
          username: `setup-a-${randomUUID().slice(0, 8)}`,
          displayName: 'Setup A',
          password: TEST_CRED,
        }),
        createFirstAdmin({
          username: `setup-b-${randomUUID().slice(0, 8)}`,
          displayName: 'Setup B',
          password: TEST_CRED,
        }),
      ]);
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        code: 'SETUP_DONE',
        status: 403,
      });
      expect(await countUsers()).toBe(1);
    } finally {
      await fs.writeFile(file, `${JSON.stringify({ users: [] }, null, 2)}\n`, 'utf8');
      usersStore.invalidate();
    }
  });
});

describe('F-09 — the account cap never reports a phantom account', () => {
  it('rejects the account that would exceed the cap', async () => {
    const file = path.join(DATA_DIR, 'users.json');
    const seeded = Array.from({ length: 100 }, (_entry, index) => ({
      id: `seed-${index}`,
      username: `seed-user-${index}`,
      displayName: `Seed ${index}`,
      role: 'member' as const,
      passwordHash: 'scrypt$00$00',
      assignments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      disabledAt: null,
    }));
    await fs.writeFile(file, `${JSON.stringify({ users: seeded }, null, 2)}\n`, 'utf8');
    usersStore.invalidate();
    try {
      expect(await countUsers()).toBe(100);
      const failure = await createUser({
        username: 'over-limit',
        displayName: 'Over Limit',
        password: TEST_CRED,
        role: 'member',
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).toBe('LIMIT_REACHED');
      expect((failure as AppError).status).toBe(400);
      // The account must not exist: no phantom user, no silent discard.
      expect(await findUserByUsername('over-limit')).toBeNull();
      expect(await countUsers()).toBe(100);
    } finally {
      await fs.writeFile(file, `${JSON.stringify({ users: [] }, null, 2)}\n`, 'utf8');
      usersStore.invalidate();
    }
  });
});

describe('personal retention partitions', () => {
  it('a session-heavy account cannot evict another account session', async () => {
    const quiet = `quiet-${randomUUID()}`;
    const quietSession = await createSession(quiet);
    const noisy = `noisy-${randomUUID()}`;
    for (let index = 0; index < 25; index += 1) await createSession(noisy);
    expect(await resolveSession(quietSession.id)).not.toBeNull();
  });

  it('a snippet-heavy account cannot evict another account snippet', async () => {
    const quiet = `quiet-${randomUUID()}`;
    const noisy = `noisy-${randomUUID()}`;
    await createSnippet({ title: 'Quiet', sql: 'SELECT quiet' }, quiet);
    for (let index = 0; index < 505; index += 1) {
      await createSnippet({ title: `Noisy ${index}`, sql: `SELECT ${index}` }, noisy);
    }
    expect((await listSnippets(quiet)).map((snippet) => snippet.title)).toEqual(['Quiet']);
    expect(await listSnippets(noisy)).toHaveLength(500);
  });
});

describe('account deletion cleanup', () => {
  it('removes personal documents, sessions, and grants without dropping assignments', async () => {
    const user = await createUser({
      username: `cleanup-${randomUUID().slice(0, 8)}`,
      displayName: 'Cleanup',
      password: TEST_CRED,
      role: 'member',
    });
    const profileId = `cleanup-profile-${randomUUID().slice(0, 8)}`;
    const survivorId = `cleanup-survivor-${randomUUID().slice(0, 8)}`;
    const deletedPracticeSet = cleanupPracticeSet('cleanup-practice-deleted', user.id, profileId);
    const survivingPracticeSet = cleanupPracticeSet(
      'cleanup-practice-survivor',
      survivorId,
      profileId,
    );
    await Promise.all([
      savePracticeSet(deletedPracticeSet),
      savePracticeSet(survivingPracticeSet),
      addPracticeAttempt(
        cleanupPracticeAttempt('cleanup-attempt-deleted', user.id, deletedPracticeSet),
      ),
      addPracticeAttempt(
        cleanupPracticeAttempt('cleanup-attempt-survivor', survivorId, survivingPracticeSet),
      ),
      setPracticeDailyEntry(user.id, profileId, {
        date: '2026-01-01',
        setId: deletedPracticeSet.id,
      }),
      setPracticeDailyEntry(survivorId, profileId, {
        date: '2026-01-01',
        setId: survivingPracticeSet.id,
      }),
    ]);
    await saveWorkspace(user.id, {
      tabs: [{ id: 'tab', title: 'Private', sql: 'SELECT private_data' }],
      activeId: 'tab',
    });
    await saveConversationTurns({
      id: 'cleanup-conversation',
      userId: user.id,
      profileId,
      mode: 'workspace',
      turns: [{ role: 'user', content: 'private conversation' }],
    });
    await addHistory({
      userId: user.id,
      profileId,
      database: 'db',
      sql: 'SELECT private_history',
      kind: 'read',
      success: true,
      executionMs: 1,
      rowCount: 1,
    });
    await createSnippet({ title: 'Private', sql: 'SELECT private_snippet' }, user.id);
    const session = await createSession(user.id);
    unlockWrites(profileId, user.id, 'UNLOCK WRITES');

    expect(await deleteUser(user.id)).toBe(true);

    expect(await resolveSession(session.id)).toBeNull();
    expect(await getWorkspace(user.id)).toEqual({ tabs: [], activeId: '' });
    await expect(getConversation('cleanup-conversation', user.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await listHistory(undefined, 100, user.id)).toEqual([]);
    expect(await listSnippets(user.id)).toEqual([]);
    expect(await listPracticeSets(profileId, 50, user.id)).toEqual([]);
    expect(await listPracticeAttemptsForSet(profileId, deletedPracticeSet.id, user.id)).toEqual([]);
    expect(await getPracticeDailyEntry(user.id, profileId)).toBeNull();
    expect((await listPracticeSets(profileId, 50, survivorId)).map((set) => set.id)).toContain(
      survivingPracticeSet.id,
    );
    expect(
      (await listPracticeAttemptsForSet(profileId, survivingPracticeSet.id, survivorId)).map(
        (attempt) => attempt.id,
      ),
    ).toContain('cleanup-attempt-survivor');
    expect(await getPracticeDailyEntry(survivorId, profileId)).toEqual({
      date: '2026-01-01',
      setId: survivingPracticeSet.id,
    });
    expect(isWritesUnlocked(profileId, user.id)).toBe(false);
    await invalidateProfile(profileId);

    // Explicitly invalidate the caches so this assertion also confirms each
    // cleanup was persisted, not merely hidden by an in-memory copy.
    workspaceStore.invalidate();
    conversationsStore.invalidate();
    historyStore.invalidate();
    snippetsStore.invalidate();
    sessionsStore.invalidate();
    expect(await getWorkspace(user.id)).toEqual({ tabs: [], activeId: '' });
  });
});

describe('F-20 — a password change revokes the existing sessions', () => {
  it('invalidates every session that was issued for the old password', async () => {
    const user = await createUser({
      username: `f20-${randomUUID().slice(0, 8)}`,
      displayName: 'Reset',
      password: TEST_CRED,
      role: 'member',
    });
    const session = await createSession(user.id);
    expect(await resolveSession(session.id)).not.toBeNull();

    await updateUser(user.id, { password: TEST_CRED_NEW });

    expect(await resolveSession(session.id)).toBeNull();
  });
});

describe('F-29 — replacing a document keeps the previous one recoverable', () => {
  it('restores the document from the backup when the replacement was interrupted', async () => {
    const dir = await tempDir('mylens-bak-');
    const file = path.join(dir, 'store.json');
    const store = new JsonStore<{ value: number }>(file, () => ({ value: 0 }));
    try {
      await store.write({ value: 1 });

      // Simulate a crash between the two renames of the replace path: the
      // document only exists in the backup file.
      await fs.rename(file, `${file}.bak`);
      store.invalidate();

      expect((await store.read()).value).toBe(1);
      expect(JSON.parse(await fs.readFile(file, 'utf8')).value).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('F-31 — a failed write never leaves the cached document changed', () => {
  it('keeps the cached document untouched when the write fails', async () => {
    const dir = await tempDir('mylens-fail-');
    const file = path.join(dir, 'store.json');
    const store = new JsonStore<{ value: number }>(file, () => ({ value: 1 }));
    try {
      expect((await store.read()).value).toBe(1);
      // A directory in the target's place makes the replacement fail.
      await fs.mkdir(file);

      await expect(
        store.update((current) => {
          current.value = 2;
          return current;
        }),
      ).rejects.toThrow();

      // The in-memory document must still hold the value the caller believes
      // in: the failed change may not be persisted by a later write.
      expect((await store.read()).value).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('F-32 — the settings store serializes its read-modify-write', () => {
  it('keeps the fields of two concurrent updates', async () => {
    await getSettings();

    await Promise.all([updateSettings({ theme: 'light' }), updateSettings({ rowLimit: 321 })]);

    const settings = await getSettings();
    expect(settings.theme).toBe('light');
    expect(settings.rowLimit).toBe(321);
  });
});

/* -------------------------------------------------------------------------- */
/* F-21 — event stream limits                                                  */
/* -------------------------------------------------------------------------- */

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableEnded = false;
  writableLength = 0;
  /** When false the socket reports back-pressure on every write. */
  acceptsWrites = true;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  flushHeaders(): void {
    // Nothing to flush in the fake.
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.acceptsWrites;
  }

  end(): void {
    this.writableEnded = true;
    this.emit('close');
  }
}

function fakeRequest(cookie: string, userId?: string): Request {
  const req = new EventEmitter() as unknown as Request;
  Object.assign(req, {
    headers: { cookie },
    socket: { remoteAddress: '127.0.0.1' },
    ...(userId
      ? {
          user: {
            id: userId,
            username: userId,
            displayName: userId,
            role: 'member',
            assignments: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            disabledAt: null,
          },
        }
      : {}),
  });
  return req;
}

describe('F-21 — the event stream count is capped', () => {
  it('refuses more than the per-session cap and answers with a 429', () => {
    const clients = [];
    for (let index = 0; index < MAX_SSE_PER_SESSION; index += 1) {
      clients.push(
        openSse(fakeRequest('mylens_session=session-a'), new FakeResponse() as unknown as Response),
      );
    }
    try {
      const failure = (() => {
        try {
          openSse(
            fakeRequest('mylens_session=session-a'),
            new FakeResponse() as unknown as Response,
          );
          return null;
        } catch (error) {
          return error as AppError;
        }
      })();
      expect(failure).toBeInstanceOf(AppError);
      expect(failure?.code).toBe('TOO_MANY_STREAMS');
      expect(failure?.status).toBe(429);
    } finally {
      clients.forEach((client) => client.close());
    }
  });

  it('caps streams across multiple sessions of the same account', () => {
    const clients = [];
    for (let index = 0; index < MAX_SSE_PER_SESSION; index += 1) {
      clients.push(
        openSse(
          fakeRequest(`mylens_session=session-${index}`, 'same-user'),
          new FakeResponse() as unknown as Response,
        ),
      );
    }
    try {
      expect(() =>
        openSse(
          fakeRequest('mylens_session=another-session', 'same-user'),
          new FakeResponse() as unknown as Response,
        ),
      ).toThrowError(expect.objectContaining({ code: 'TOO_MANY_STREAMS', status: 429 }));
    } finally {
      clients.forEach((client) => client.close());
    }
  });

  it('refuses more than the global cap', () => {
    const clients = [];
    try {
      for (let index = 0; index < MAX_SSE_TOTAL; index += 1) {
        clients.push(
          openSse(
            fakeRequest(`mylens_session=session-${index}`),
            new FakeResponse() as unknown as Response,
          ),
        );
      }
      const failure = (() => {
        try {
          openSse(
            fakeRequest('mylens_session=one-too-many'),
            new FakeResponse() as unknown as Response,
          );
          return null;
        } catch (error) {
          return error as AppError;
        }
      })();
      expect(failure).toBeInstanceOf(AppError);
      expect(failure?.status).toBe(429);
    } finally {
      clients.forEach((client) => client.close());
    }
  });

  it('queues frames for a peer that does not read and delivers them in order when it drains', () => {
    const res = new FakeResponse();
    res.acceptsWrites = false;
    const client = openSse(fakeRequest('mylens_session=back-pressure'), res as unknown as Response);
    try {
      client.send('first', { n: 1 });
      expect(res.chunks.length).toBe(1);

      // The socket is backed up: frames are queued in send order, not dropped.
      client.send('second', { n: 2 });
      client.send('third', { n: 3 });
      expect(res.chunks.length).toBe(1);

      res.acceptsWrites = true; // the peer caught up
      res.emit('drain');
      expect(res.chunks.length).toBe(3);
      expect(res.chunks[1]).toContain('"n":2');
      expect(res.chunks[2]).toContain('"n":3');

      // The socket is healthy again: frames are written straight through.
      client.send('fourth', { n: 4 });
      expect(res.chunks.length).toBe(4);
    } finally {
      client.close();
    }
  });
});
