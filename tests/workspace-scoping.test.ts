import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { useWorkspaceStore } from '../src/store/workspace-store';

/**
 * Multi-user isolation for server-side persistence: the workspace (tabs,
 * SQL, per-tab AI threads) belongs to the signed-in account and is stored on
 * the server — never in the browser — so it follows the account across
 * devices and can never surface under another account, on this PC or any
 * other. Regression for the report that one account's editor tabs and AI
 * chats were visible under another account signed in on the same browser.
 */

interface MockTab {
  id: string;
  title: string;
  sql: string;
}

const apiMock = vi.hoisted(() => {
  const blobs = new Map<
    string,
    { tabs: Array<{ id: string; title: string; sql: string }>; activeId: string }
  >();
  /** Every request the store made, in order, with the account the "session" had. */
  const calls: Array<{ kind: 'get' | 'put'; user: string | null; body?: unknown }> = [];
  /** Which account the mock server's session cookie carries for the next request. */
  const session = { user: null as string | null };
  /** Simulated server failure for GETs / PUTs until cleared. */
  const getFailure = { error: null as Error | null };
  const putFailure = { error: null as Error | null };
  return { blobs, calls, session, getFailure, putFailure };
});

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async () => {
      const user = apiMock.session.user;
      apiMock.calls.push({ kind: 'get', user });
      if (apiMock.getFailure.error) throw apiMock.getFailure.error;
      const blob = apiMock.blobs.get(user ?? '');
      return blob
        ? { tabs: blob.tabs.map((tab) => ({ ...tab })), activeId: blob.activeId }
        : { tabs: [], activeId: '' };
    }),
    put: vi.fn(async (_path: string, body: unknown) => {
      const user = apiMock.session.user;
      apiMock.calls.push({ kind: 'put', user, body });
      if (apiMock.putFailure.error) throw apiMock.putFailure.error;
      const payload = body as { tabs: MockTab[]; activeId: string };
      apiMock.blobs.set(user ?? '', {
        tabs: payload.tabs.map((tab) => ({ ...tab })),
        activeId: payload.activeId,
      });
      return { saved: true };
    }),
  },
  getApiToken: () => 'test-token',
}));

type Store = Record<string, string>;
const backing: Store = {};
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

/**
 * Pumps the async work: hydrate dispatches its server load on a microtask and
 * the mocked api resolves on microtasks too. The zero-millisecond tick only
 * matters if the environment fakes microtask scheduling; otherwise it is a
 * no-op.
 */
async function settle(): Promise<void> {
  vi.advanceTimersByTime(0);
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

describe('workspace store server persistence (per-user scoping)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Signing out flushes the previous owner's pending save; wipe the mock
    // server afterwards so every test starts from a clean slate.
    apiMock.session.user = null;
    store().hydrateForUser(null);
    apiMock.blobs.clear();
    apiMock.calls.length = 0;
    apiMock.getFailure.error = null;
    apiMock.putFailure.error = null;
    storageShim.clear();
  });

  it('loads the account’s server workspace when it signs in', async () => {
    apiMock.session.user = 'user-admin';
    apiMock.blobs.set('user-admin', {
      tabs: [{ id: 'srv-1', title: 'Server tab', sql: 'SELECT from_server;' }],
      activeId: 'srv-1',
    });
    store().hydrateForUser('user-admin');
    await settle();

    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0].id).toBe('srv-1');
    expect(store().tabs[0].title).toBe('Server tab');
    expect(store().tabs[0].sql).toContain('from_server');
    // The persisted shape was rebuilt into a live tab: derived state starts fresh.
    expect(store().tabs[0].result).toBeNull();
    expect(store().activeId).toBe('srv-1');
    // Adopting the server blob persists nothing extra.
    expect(apiMock.calls.filter((call) => call.kind === 'put')).toEqual([]);
  });

  it('commits the outgoing owner’s pending edit to the server before loading the next account', async () => {
    apiMock.session.user = 'user-admin';
    store().hydrateForUser('user-admin');
    await settle();
    store().updateSql(store().activeId, 'SELECT secret_from_admin;');
    // The session now belongs to the member. The flush is dispatched before
    // the owner swap, so it leaves while the session is still the admin's.
    store().hydrateForUser('user-member');
    apiMock.session.user = 'user-member';
    await settle();

    const flushPutIndex = apiMock.calls.findIndex(
      (call) =>
        call.kind === 'put' &&
        call.user === 'user-admin' &&
        JSON.stringify(call.body).includes('secret_from_admin'),
    );
    expect(flushPutIndex).toBeGreaterThanOrEqual(0);
    const memberLoadIndex = apiMock.calls.findIndex(
      (call) => call.kind === 'get' && call.user === 'user-member',
    );
    expect(memberLoadIndex).toBeGreaterThan(flushPutIndex);
    expect(JSON.stringify(apiMock.blobs.get('user-admin'))).toContain('secret_from_admin');
    // The member has not adopted (or yet saved over) anything.
    expect(apiMock.blobs.get('user-member')).toBeUndefined();
  });

  it('keeps each account’s workspace in its own server-side blob', async () => {
    apiMock.session.user = 'user-admin';
    store().hydrateForUser('user-admin');
    await settle();
    store().updateSql(store().activeId, 'SELECT admin_data;');
    store().hydrateForUser('user-member');
    apiMock.session.user = 'user-member';
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

  it('restores an account’s own workspace when it signs back in', async () => {
    apiMock.session.user = 'user-admin';
    store().hydrateForUser('user-admin');
    await settle();
    store().updateSql(store().activeId, 'SELECT admin_returns;');
    store().hydrateForUser(null);
    apiMock.session.user = 'user-admin';
    store().hydrateForUser('user-admin');
    await settle();

    expect(store().tabs[0].sql).toContain('admin_returns');
  });

  it('makes no server calls while signed out', async () => {
    store().hydrateForUser(null);
    store().updateSql(store().activeId, 'SELECT 1;');
    vi.advanceTimersByTime(500);
    await settle();

    expect(apiMock.calls).toEqual([]);
    expect(store().tabs).toHaveLength(1);
  });

  it('keeps the in-memory workspace when a save fails, then retries on the next save', async () => {
    apiMock.session.user = 'user-admin';
    store().hydrateForUser('user-admin');
    await settle();
    apiMock.putFailure.error = new Error('server unreachable');
    store().updateSql(store().activeId, 'SELECT kept_in_memory;');
    vi.advanceTimersByTime(500);
    await settle();
    // The failed PUT must not clear or alter the in-memory state, and it
    // persisted nothing for the admin.
    expect(store().tabs[0].sql).toContain('kept_in_memory');
    expect(apiMock.blobs.get('user-admin')).toBeUndefined();

    apiMock.putFailure.error = null;
    store().setActive(store().activeId);
    vi.advanceTimersByTime(500);
    await settle();
    expect(JSON.stringify(apiMock.blobs.get('user-admin'))).toContain('kept_in_memory');
  });

  it('keeps the blank workspace and warns once when the load fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      apiMock.getFailure.error = new Error('server unreachable');
      apiMock.session.user = 'user-admin';
      store().hydrateForUser('user-admin');
      await settle();
      store().hydrateForUser(null);
      apiMock.session.user = 'user-admin';
      store().hydrateForUser('user-admin');
      await settle();

      // Warned once for the session, not once per failing retry.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(store().tabs).toHaveLength(1);
      expect(store().tabs[0].sql).not.toContain('admin_returns');
    } finally {
      warn.mockRestore();
    }
  });

  it('drops the legacy global key instead of adopting it', async () => {
    // A fresh module instance: the one-time cleanup runs on its first hydrate.
    vi.resetModules();
    const { useWorkspaceStore: freshStore } = await import('../src/store/workspace-store');
    storageShim.setItem(
      'mylens.workspace.v1',
      JSON.stringify({
        tabs: [{ id: 'legacy', title: 'Query', sql: 'SELECT leaked;' }],
        activeId: 'legacy',
      }),
    );
    apiMock.session.user = 'user-member';
    freshStore.getState().hydrateForUser('user-member');
    expect(storageShim.getItem('mylens.workspace.v1')).toBeNull();
  });
});

describe('session wiring and draft scoping (source pins)', () => {
  const appSource = readFileSync(new URL('../src/store/app-store.ts', import.meta.url), 'utf8');
  const practiceSource = readFileSync(
    new URL('../src/pages/PracticePage.tsx', import.meta.url),
    'utf8',
  );

  it('app-store hydrates the workspace on session resolve, sign-in and sign-out', () => {
    expect(appSource).toContain('hydrateForUser(boot.currentUser?.id ?? null)');
    expect(appSource).toContain('hydrateForUser(result.user.id)');
    expect(appSource).toContain('hydrateForUser(null)');
  });

  it('remembers the selected profile per account', () => {
    expect(appSource).toContain('function activeProfileKey(userId');
    expect(appSource).not.toContain('localStorage.setItem(ACTIVE_KEY');
  });

  it('keys practice drafts by user id', () => {
    expect(practiceSource).toContain('${DRAFT_PREFIX}.${userId}.${profileId}.${setId}');
    // Whitespace-tolerant: prettier may wrap the long call-site arguments.
    expect(practiceSource).toMatch(/readDraft\(\s*useAppStore\.getState\(\)\.currentUser\?\.id/);
    expect(practiceSource).toMatch(/writeDraft\(\s*useAppStore\.getState\(\)\.currentUser\?\.id/);
  });
});
