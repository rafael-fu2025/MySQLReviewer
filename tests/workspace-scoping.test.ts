import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { useWorkspaceStore } from '../src/store/workspace-store';

interface MockTab {
  id: string;
  title: string;
  sql: string;
}

interface Snapshot {
  epoch: number;
  userId: string | null;
}

const apiMock = vi.hoisted(() => {
  const blobs = new Map<
    string,
    { tabs: Array<{ id: string; title: string; sql: string }>; activeId: string }
  >();
  const calls: Array<{
    kind: 'get' | 'put';
    user: string | null;
    expected: string | null;
    epoch: number;
    body?: unknown;
  }> = [];
  const session = { userId: null as string | null, epoch: 1, frozen: false };
  const getFailure = { error: null as Error | null };
  const putFailure = { error: null as Error | null };
  const getDeferred = { promise: null as Promise<unknown> | null };
  const putDeferred = { promise: null as Promise<unknown> | null };
  return { blobs, calls, session, getFailure, putFailure, getDeferred, putDeferred };
});

vi.mock('@/lib/api', () => {
  class SessionChangedError extends Error {
    code = 'SESSION_CHANGED';
  }
  const current = (snapshot: Snapshot, allow = false) =>
    snapshot.epoch === apiMock.session.epoch &&
    snapshot.userId === apiMock.session.userId &&
    (allow || !apiMock.session.frozen);
  return {
    api: {
      get: vi.fn(async (_path: string, options?: { session?: Snapshot }) => {
        const expected = options?.session ?? { ...apiMock.session };
        apiMock.calls.push({
          kind: 'get',
          user: apiMock.session.userId,
          expected: expected.userId,
          epoch: expected.epoch,
        });
        if (!current(expected)) throw new SessionChangedError();
        if (apiMock.getFailure.error) throw apiMock.getFailure.error;
        if (apiMock.getDeferred.promise) await apiMock.getDeferred.promise;
        if (!current(expected)) throw new SessionChangedError();
        const blob = apiMock.blobs.get(expected.userId ?? '');
        return blob
          ? { tabs: blob.tabs.map((tab) => ({ ...tab })), activeId: blob.activeId }
          : { tabs: [], activeId: '' };
      }),
      put: vi.fn(async (_path: string, body: unknown, options?: { session?: Snapshot }) => {
        const expected = options?.session ?? { ...apiMock.session };
        apiMock.calls.push({
          kind: 'put',
          user: apiMock.session.userId,
          expected: expected.userId,
          epoch: expected.epoch,
          body,
        });
        if (!current(expected)) throw new SessionChangedError();
        if (apiMock.putFailure.error) throw apiMock.putFailure.error;
        if (apiMock.putDeferred.promise) await apiMock.putDeferred.promise;
        if (!current(expected)) throw new SessionChangedError();
        const payload = body as { tabs: MockTab[]; activeId: string };
        apiMock.blobs.set(expected.userId ?? '', {
          tabs: payload.tabs.map((tab) => ({ ...tab })),
          activeId: payload.activeId,
        });
        return { saved: true };
      }),
    },
    getApiSessionSnapshot: () => ({
      epoch: apiMock.session.epoch,
      userId: apiMock.session.userId,
    }),
    isApiSessionCurrent: (snapshot: Snapshot, allow?: boolean) => current(snapshot, allow),
    assertApiSessionCurrent: (snapshot: Snapshot, allow?: boolean) => {
      if (!current(snapshot, allow)) throw new SessionChangedError();
    },
    apiSessionHeaders: (snapshot: Snapshot) => ({
      'x-mylens-token': 'test-token',
      ...(snapshot.userId ? { 'x-mylens-expected-user-id': snapshot.userId } : {}),
    }),
  };
});

const backing: Record<string, string> = {};
const storageShim = {
  getItem: (key: string) => (key in backing ? backing[key] : null),
  setItem: (key: string, value: string) => {
    backing[key] = value;
  },
  removeItem: (key: string) => {
    delete backing[key];
  },
  clear: () => {
    for (const key of Object.keys(backing)) delete backing[key];
  },
};

beforeAll(() => {
  vi.stubGlobal('localStorage', storageShim);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.useRealTimers();
});

const store = () => useWorkspaceStore.getState();
const session = (): Snapshot => ({
  epoch: apiMock.session.epoch,
  userId: apiMock.session.userId,
});

function become(userId: string | null): Snapshot {
  apiMock.session.epoch += 1;
  apiMock.session.userId = userId;
  apiMock.session.frozen = false;
  return session();
}

async function settle(): Promise<void> {
  vi.advanceTimersByTime(0);
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('workspace store server persistence (per-user scoping)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const anonymous = become(null);
    store().hydrateForUser(null, anonymous);
    apiMock.blobs.clear();
    apiMock.calls.length = 0;
    apiMock.getFailure.error = null;
    apiMock.putFailure.error = null;
    apiMock.getDeferred.promise = null;
    apiMock.putDeferred.promise = null;
    storageShim.clear();
  });

  it('loads the account’s server workspace when it signs in', async () => {
    const a = become('user-admin');
    apiMock.blobs.set('user-admin', {
      tabs: [{ id: 'srv-1', title: 'Server tab', sql: 'SELECT from_server;' }],
      activeId: 'srv-1',
    });
    store().hydrateForUser('user-admin', a);
    await settle();

    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0].id).toBe('srv-1');
    expect(store().tabs[0].title).toBe('Server tab');
    expect(store().tabs[0].sql).toContain('from_server');
    expect(store().tabs[0].result).toBeNull();
    expect(store().activeId).toBe('srv-1');
    expect(apiMock.calls.filter((call) => call.kind === 'put')).toEqual([]);
  });

  it('flushes the outgoing owner awaitably before logout changes the session', async () => {
    const a = become('user-admin');
    store().hydrateForUser('user-admin', a);
    await settle();
    store().updateSql(store().activeId, 'SELECT secret_from_admin;');

    await store().flushForUser('user-admin', a);
    const anonymous = become(null);
    store().hydrateForUser(null, anonymous);

    const flush = apiMock.calls.find(
      (call) => call.kind === 'put' && JSON.stringify(call.body).includes('secret_from_admin'),
    );
    expect(flush).toMatchObject({ user: 'user-admin', expected: 'user-admin', epoch: a.epoch });
    expect(JSON.stringify(apiMock.blobs.get('user-admin'))).toContain('secret_from_admin');
    expect(store().ownerId).toBeNull();
    expect(store().tabs[0].sql).not.toContain('secret_from_admin');
  });

  it('keeps each account’s workspace in its own server-side blob', async () => {
    const a = become('user-admin');
    store().hydrateForUser('user-admin', a);
    await settle();
    store().updateSql(store().activeId, 'SELECT admin_data;');
    await store().flushForUser('user-admin', a);

    const b = become('user-member');
    store().hydrateForUser('user-member', b);
    await settle();
    store().updateSql(store().activeId, 'SELECT member_data;');
    vi.advanceTimersByTime(500);
    await settle();

    const adminBlob = JSON.stringify(apiMock.blobs.get('user-admin'));
    const memberBlob = JSON.stringify(apiMock.blobs.get('user-member'));
    expect(adminBlob).toContain('admin_data');
    expect(adminBlob).not.toContain('member_data');
    expect(memberBlob).toContain('member_data');
    expect(memberBlob).not.toContain('admin_data');
  });

  it('restores A only when A signs back in after A -> logout -> B', async () => {
    const a = become('user-admin');
    store().hydrateForUser('user-admin', a);
    await settle();
    store().updateSql(store().activeId, 'SELECT admin_returns;');
    await store().flushForUser('user-admin', a);

    store().hydrateForUser(null, become(null));
    const b = become('user-member');
    store().hydrateForUser('user-member', b);
    await settle();
    expect(store().tabs[0].sql).not.toContain('admin_returns');
    store().updateSql(store().activeId, 'SELECT member_only;');
    await store().flushForUser('user-member', b);

    const aAgain = become('user-admin');
    store().hydrateForUser('user-admin', aAgain);
    await settle();
    expect(store().tabs[0].sql).toContain('admin_returns');
    expect(store().tabs[0].sql).not.toContain('member_only');
  });

  it('drops a stale A load that resolves after B is active', async () => {
    const gate = deferred();
    apiMock.getDeferred.promise = gate.promise;
    const a = become('user-admin');
    apiMock.blobs.set('user-admin', {
      tabs: [{ id: 'a-tab', title: 'A', sql: 'SELECT A_SECRET;' }],
      activeId: 'a-tab',
    });
    store().hydrateForUser('user-admin', a);
    await settle();

    const b = become('user-member');
    apiMock.getDeferred.promise = null;
    store().hydrateForUser('user-member', b);
    await settle();
    store().updateSql(store().activeId, 'SELECT B_VISIBLE;');

    gate.resolve();
    await settle();
    expect(store().ownerId).toBe('user-member');
    expect(store().tabs[0].sql).toContain('B_VISIBLE');
    expect(store().tabs[0].sql).not.toContain('A_SECRET');
  });

  it('makes no server calls while signed out', async () => {
    store().hydrateForUser(null, session());
    store().updateSql(store().activeId, 'SELECT 1;');
    vi.advanceTimersByTime(500);
    await settle();

    expect(apiMock.calls).toEqual([]);
    expect(store().tabs).toHaveLength(1);
  });

  it('drains an edit made while an earlier save is in flight before logout resolves', async () => {
    const a = become('user-admin');
    store().hydrateForUser('user-admin', a);
    await settle();
    store().updateSql(store().activeId, 'SELECT first_revision;');

    const gate = deferred();
    apiMock.putDeferred.promise = gate.promise;
    vi.advanceTimersByTime(500);
    await settle();
    store().updateSql(store().activeId, 'SELECT final_revision;');
    const logoutFlush = store().flushForUser('user-admin', a);

    apiMock.putDeferred.promise = null;
    gate.resolve();
    await logoutFlush;
    await settle();

    expect(JSON.stringify(apiMock.blobs.get('user-admin'))).toContain('final_revision');
    const writes = apiMock.calls.filter((call) => call.kind === 'put');
    expect(writes.some((call) => JSON.stringify(call.body).includes('first_revision'))).toBe(true);
    expect(writes.some((call) => JSON.stringify(call.body).includes('final_revision'))).toBe(true);
  });

  it('keeps a failed save queued and retries it without losing the snapshot', async () => {
    const a = become('user-admin');
    store().hydrateForUser('user-admin', a);
    await settle();
    apiMock.putFailure.error = new Error('server unreachable');
    store().updateSql(store().activeId, 'SELECT kept_in_memory;');
    vi.advanceTimersByTime(500);
    await settle();
    expect(store().tabs[0].sql).toContain('kept_in_memory');
    expect(apiMock.blobs.get('user-admin')).toBeUndefined();

    apiMock.putFailure.error = null;
    vi.advanceTimersByTime(1_300);
    await settle();
    expect(JSON.stringify(apiMock.blobs.get('user-admin'))).toContain('kept_in_memory');
  });

  it('never retries an A write after the epoch changes to B', async () => {
    const a = become('user-admin');
    store().hydrateForUser('user-admin', a);
    await settle();
    apiMock.putFailure.error = new Error('server unreachable');
    store().updateSql(store().activeId, 'SELECT stale_a;');
    vi.advanceTimersByTime(500);
    await settle();

    apiMock.putFailure.error = null;
    const b = become('user-member');
    store().hydrateForUser('user-member', b);
    await settle();
    vi.advanceTimersByTime(2_000);
    await settle();

    expect(JSON.stringify(apiMock.blobs.get('user-member'))).not.toContain('stale_a');
    const staleAWrites = apiMock.calls.filter(
      (call) => call.kind === 'put' && JSON.stringify(call.body).includes('stale_a'),
    );
    expect(staleAWrites).toHaveLength(1);
  });

  it('keeps the blank workspace and warns once when a current load fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      apiMock.getFailure.error = new Error('server unreachable');
      const a = become('user-admin');
      store().hydrateForUser('user-admin', a);
      await settle();
      store().hydrateForUser(null, become(null));
      const aAgain = become('user-admin');
      store().hydrateForUser('user-admin', aAgain);
      await settle();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(store().tabs).toHaveLength(1);
      expect(store().tabs[0].sql).not.toContain('admin_returns');
    } finally {
      warn.mockRestore();
    }
  });

  it('drops the legacy global key instead of adopting it', async () => {
    vi.resetModules();
    const { useWorkspaceStore: freshStore } = await import('../src/store/workspace-store');
    storageShim.setItem(
      'mylens.workspace.v1',
      JSON.stringify({
        tabs: [{ id: 'legacy', title: 'Query', sql: 'SELECT leaked;' }],
        activeId: 'legacy',
      }),
    );
    const b = become('user-member');
    freshStore.getState().hydrateForUser('user-member', b);
    expect(storageShim.getItem('mylens.workspace.v1')).toBeNull();
  });
});

describe('session wiring and draft scoping (source pins)', () => {
  const appSource = readFileSync(new URL('../src/store/app-store.ts', import.meta.url), 'utf8');
  const practiceSource = readFileSync(
    new URL('../src/pages/PracticePage.tsx', import.meta.url),
    'utf8',
  );

  it('publishes bootstrap atomically and awaits workspace flush before logout', () => {
    expect(appSource).toContain('await publishBootstrap(boot, resolvedSession)');
    const flushIndex = appSource.indexOf(
      'await useWorkspaceStore.getState().flushForUser(user.id, settledSession)',
    );
    const logoutIndex = appSource.indexOf("'/api/auth/logout'", flushIndex);
    expect(flushIndex).toBeGreaterThan(-1);
    expect(logoutIndex).toBeGreaterThan(flushIndex);
  });

  it('remembers the selected profile per account', () => {
    expect(appSource).toContain('function activeProfileKey(userId');
    expect(appSource).not.toContain('localStorage.setItem(ACTIVE_KEY');
  });

  it('keys practice drafts by user id', () => {
    expect(practiceSource).toContain('${DRAFT_PREFIX}.${userId}.${profileId}.${setId}');
    expect(practiceSource).toContain('readDraft(currentUserId, activeProfileId, practiceSet.id)');
    expect(practiceSource).toContain(
      'writeDraft(currentUserId, activeProfileId, practiceSet.id, drafts)',
    );
  });
});
