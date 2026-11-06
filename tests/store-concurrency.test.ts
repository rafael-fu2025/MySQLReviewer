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
import {
  addAssignment,
  countUsers,
  createUser,
  deleteUser,
  findUserByUsername,
  setAssignments,
  updateUser,
  usersStore,
} from '../server/store/users';
import { createSession, resolveSession } from '../server/store/sessions';
import { getSettings, updateSettings } from '../server/store/settings';
import { MAX_SSE_PER_SESSION, MAX_SSE_TOTAL, openSse } from '../server/sse';
import type { SandboxAssignment } from '../shared/types';

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

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe('F-08 — the users store serializes its read-modify-write', () => {
  it('does not lose a concurrent delete when another writer updates a different account', async () => {
    const kept = await createUser({
      username: `f08-keep-${randomUUID().slice(0, 8)}`,
      displayName: 'Kept',
      password: 'review123',
      role: 'member',
    });
    const removed = await createUser({
      username: `f08-removed-${randomUUID().slice(0, 8)}`,
      displayName: 'Removed',
      password: 'review123',
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
      password: 'review123',
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
        password: 'review123',
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

describe('F-20 — a password change revokes the existing sessions', () => {
  it('invalidates every session that was issued for the old password', async () => {
    const user = await createUser({
      username: `f20-${randomUUID().slice(0, 8)}`,
      displayName: 'Reset',
      password: 'old-password',
      role: 'member',
    });
    const session = await createSession(user.id);
    expect(await resolveSession(session.id)).not.toBeNull();

    await updateUser(user.id, { password: 'new-password' });

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

function fakeRequest(cookie: string): Request {
  const req = new EventEmitter() as unknown as Request;
  Object.assign(req, {
    headers: { cookie },
    socket: { remoteAddress: '127.0.0.1' },
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

  it('stops writing to a peer that does not read and resumes when it drains', () => {
    const res = new FakeResponse();
    res.acceptsWrites = false;
    const client = openSse(fakeRequest('mylens_session=back-pressure'), res as unknown as Response);
    try {
      client.send('first', { n: 1 });
      expect(res.chunks.length).toBe(1);

      // The socket is backed up: the frame is dropped instead of piling up.
      client.send('second', { n: 2 });
      expect(res.chunks.length).toBe(1);

      res.emit('drain');
      client.send('third', { n: 3 });
      expect(res.chunks.length).toBe(2);
    } finally {
      client.close();
    }
  });
});
