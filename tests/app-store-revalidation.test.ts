import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiProvider,
  AppSettings,
  BootstrapInfo,
  ConnectionProfile,
  PublicUser,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const apiMock = vi.hoisted(() => ({
  boot: null as BootstrapInfo | null,
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: apiMock.get,
      post: apiMock.post,
      put: apiMock.put,
      del: vi.fn(),
    },
  };
});

import {
  ApiError,
  beginApiSessionTransition,
  commitApiSession,
  getApiSessionSnapshot,
  isApiSessionFrozen,
  SessionChangedError,
} from '@/lib/api';
import { useAppStore } from '@/store/app-store';
import { useUiStore } from '@/store/ui-store';
import { useWorkspaceStore } from '@/store/workspace-store';

const storage = new Map<string, string>();
const windowStub = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  matchMedia: () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
  addEventListener: vi.fn(),
  BroadcastChannel: undefined,
};
const documentStub = { documentElement: { dataset: {} as Record<string, string> } };

function user(id: string, patch: Partial<PublicUser> = {}): PublicUser {
  return {
    id,
    username: id,
    displayName: id.toUpperCase(),
    role: 'admin',
    assignments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    disabledAt: null,
    theme: 'dark',
    ...patch,
  };
}

function profile(id: string): ConnectionProfile {
  return {
    id,
    name: id,
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    database: 'db',
    socketPath: null,
    ssl: null,
    rememberPassword: true,
    hasPassword: true,
    passwordSource: 'saved',
    color: null,
    databaseScope: 'all',
    allowedDatabases: [],
    allowServerWideInsights: true,
    writeAccess: 'full',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function provider(id: string): AiProvider {
  return {
    id,
    name: id,
    type: 'openai',
    baseUrl: 'https://example.test/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    model: 'test-model',
    models: ['test-model'],
    hasApiKey: true,
    apiKeyHint: '••••test',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    headers: {},
    extraBody: {},
    temperature: 0,
    maxTokens: 1_000,
    streaming: true,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function bootstrap(currentUser: PublicUser, patch: Partial<BootstrapInfo> = {}): BootstrapInfo {
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    theme: currentUser.id === 'user-b' ? 'light' : 'dark',
  };
  return {
    appName: 'MyLens',
    version: 'test',
    token: `token-${currentUser.id}`,
    platform: 'win32',
    nodeVersion: 'test',
    dataDir: 'test',
    clientBuilt: true,
    detectedXampp: null,
    profiles: [],
    providers: [],
    settings,
    activeProfileId: null,
    auth: { needsSetup: false },
    currentUser,
    ...patch,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function workspaceSql(): string {
  return useWorkspaceStore.getState().tabs[0]?.sql ?? '';
}

function seedApp(boot: BootstrapInfo): void {
  useAppStore.setState({
    ready: true,
    bootError: null,
    boot,
    profiles: boot.profiles,
    providers: boot.providers,
    settings: boot.settings,
    detectedXampp: boot.detectedXampp,
    theme: boot.settings.theme,
    currentUser: boot.currentUser,
    needsSetup: false,
    activeProfileId: null,
    server: null,
    databases: [],
    selectedDatabase: null,
    schema: null,
    objects: null,
    schemaLoading: false,
    unlockedUntil: null,
    toasts: [],
    paletteOpen: false,
  });
}

async function establishA(
  bootA = bootstrap(user('user-a')),
): Promise<ReturnType<typeof getApiSessionSnapshot>> {
  const a = beginApiSessionTransition('user-a');
  commitApiSession(a);
  apiMock.boot = bootA;
  useWorkspaceStore.getState().hydrateForUser('user-a', a);
  useUiStore.getState().hydrateForUser('user-a');
  seedApp(bootA);
  await settle();
  return a;
}

beforeAll(() => {
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('localStorage', windowStub.localStorage);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('app-store authentication and session reconciliation', () => {
  beforeEach(async () => {
    storage.clear();
    const anonymous = beginApiSessionTransition(null);
    commitApiSession(anonymous);
    useWorkspaceStore.getState().hydrateForUser(null, anonymous);
    useUiStore.getState().hydrateForUser(null);

    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/api/bootstrap') return apiMock.boot;
      if (path === '/api/workspace') return { tabs: [], activeId: '' };
      throw new Error(`Unexpected GET ${path}`);
    });
    apiMock.post.mockImplementation(async (path: string) => {
      throw new Error(`Unexpected POST ${path}`);
    });
    apiMock.put.mockResolvedValue({});
    await establishA();
  });

  it('keeps pending debounced SQL and live UI state on same-user focus revalidation', async () => {
    const workspace = useWorkspaceStore.getState();
    workspace.updateSql(workspace.activeId, 'SELECT pending_same_user;');
    useUiStore.getState().setEditorPct(67);
    useUiStore.getState().setFormatOptions({ keywordCase: 'lower' });
    const beforeSession = getApiSessionSnapshot();
    const beforeTabId = useWorkspaceStore.getState().activeId;

    await useAppStore.getState().revalidateSession();

    expect(getApiSessionSnapshot()).toEqual(beforeSession);
    expect(isApiSessionFrozen()).toBe(false);
    expect(useAppStore.getState().ready).toBe(true);
    expect(useAppStore.getState().currentUser?.id).toBe('user-a');
    expect(useWorkspaceStore.getState().ownerId).toBe('user-a');
    expect(useWorkspaceStore.getState().activeId).toBe(beforeTabId);
    expect(workspaceSql()).toContain('pending_same_user');
    expect(useUiStore.getState().ownerId).toBe('user-a');
    expect(useUiStore.getState().editorPct).toBe(67);
    expect(useUiStore.getState().formatKeywordCase).toBe('lower');
    expect(apiMock.get).toHaveBeenCalledWith(
      '/api/bootstrap',
      expect.objectContaining({ includeExpectedUser: false, bypassSessionGuard: true }),
    );
  });

  it('atomically refreshes same-user metadata, assignments, theme, profiles, providers and settings', async () => {
    const assignment = {
      id: 'assignment-1',
      profileId: 'profile-2',
      source: 'source_db',
      sandbox: 'sandbox_db',
      includeData: true,
      createdAt: '2026-01-02T00:00:00.000Z',
    };
    const refreshed = user('user-a', {
      displayName: 'A Refreshed',
      assignments: [assignment],
      theme: 'light',
    });
    const refreshedSettings = { ...DEFAULT_SETTINGS, theme: 'light' as const };
    apiMock.boot = bootstrap(refreshed, {
      profiles: [profile('profile-2')],
      providers: [provider('provider-2')],
      settings: refreshedSettings,
    });
    const workspace = useWorkspaceStore.getState();
    workspace.updateSql(workspace.activeId, 'SELECT metadata_refresh_kept;');
    useUiStore.getState().setEditorPct(69);

    await useAppStore.getState().revalidateSession();

    const app = useAppStore.getState();
    expect(app.currentUser).toMatchObject({
      displayName: 'A Refreshed',
      assignments: [assignment],
    });
    expect(app.profiles.map((item) => item.id)).toEqual(['profile-2']);
    expect(app.providers.map((item) => item.id)).toEqual(['provider-2']);
    expect(app.settings).toEqual(refreshedSettings);
    expect(app.theme).toBe('light');
    expect(documentStub.documentElement.dataset.theme).toBe('light');
    expect(workspaceSql()).toContain('metadata_refresh_kept');
    expect(useUiStore.getState().editorPct).toBe(69);
  });

  it('clears only local connection context when same-user refresh revokes the active profile', async () => {
    const active = profile('profile-revoked');
    const bootA = bootstrap(user('user-a'), { profiles: [active] });
    await establishA(bootA);
    storage.set('mylens.activeProfile.user-a', active.id);
    useAppStore.setState({
      activeProfileId: active.id,
      server: { version: '8.0', flavor: 'mysql', uptimeSeconds: 1, capabilities: {} } as never,
      databases: [
        {
          name: 'db',
          isSystem: false,
          tableCount: 1,
          viewCount: 0,
          sizeBytes: 1,
          collation: null,
        },
      ],
      selectedDatabase: 'db',
    });
    const workspace = useWorkspaceStore.getState();
    workspace.updateSql(workspace.activeId, 'SELECT revoked_profile_kept;');
    useUiStore.getState().setEditorPct(71);
    apiMock.boot = bootstrap(user('user-a'), { profiles: [] });

    await useAppStore.getState().revalidateSession();

    expect(apiMock.post).not.toHaveBeenCalledWith(
      `/api/connections/${active.id}/disconnect`,
      expect.anything(),
      expect.anything(),
    );
    expect(useAppStore.getState()).toMatchObject({
      activeProfileId: null,
      server: null,
      databases: [],
      selectedDatabase: null,
    });
    expect(storage.has('mylens.activeProfile.user-a')).toBe(false);
    expect(workspaceSql()).toContain('revoked_profile_kept');
    expect(useUiStore.getState().editorPct).toBe(71);
  });

  it('switches safely only after a probe verifies a changed cookie identity', async () => {
    const workspace = useWorkspaceStore.getState();
    workspace.updateSql(workspace.activeId, 'SELECT user_a_secret;');
    useUiStore.getState().setEditorPct(67);
    apiMock.boot = bootstrap(user('user-b'));

    await useAppStore.getState().revalidateSession();
    await settle();

    expect(getApiSessionSnapshot().userId).toBe('user-b');
    expect(isApiSessionFrozen()).toBe(false);
    expect(useAppStore.getState().ready).toBe(true);
    expect(useAppStore.getState().currentUser?.id).toBe('user-b');
    expect(useAppStore.getState().theme).toBe('light');
    expect(useWorkspaceStore.getState().ownerId).toBe('user-b');
    expect(workspaceSql()).not.toContain('user_a_secret');
    expect(useUiStore.getState().ownerId).toBe('user-b');
    expect(useUiStore.getState().editorPct).toBe(42);
  });

  it('failed login with cookie still A republishes A instead of leaving a blank shell', async () => {
    const workspace = useWorkspaceStore.getState();
    workspace.updateSql(workspace.activeId, 'SELECT before_failed_login;');
    useUiStore.getState().setEditorPct(66);
    apiMock.boot = bootstrap(user('user-a'));
    apiMock.post.mockImplementation(async (path: string) => {
      if (path === '/api/auth/login') {
        throw new ApiError('INVALID_CREDENTIALS', 'Wrong username or password.', 401);
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    await expect(useAppStore.getState().login('user-b', 'wrong-pass')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });

    expect(useAppStore.getState().ready).toBe(true);
    expect(useAppStore.getState().currentUser?.id).toBe('user-a');
    expect(useWorkspaceStore.getState().ownerId).toBe('user-a');
    expect(useUiStore.getState().ownerId).toBe('user-a');
    expect(isApiSessionFrozen()).toBe(false);
    // clearForTransition deliberately dropped the unflushed local snapshot; the
    // verified A bootstrap then loads A's durable workspace instead of staying blank.
    expect(workspaceSql()).not.toContain('before_failed_login');
  });

  it('a later revalidation publishes B after login changed the cookie but initial bootstrap failed', async () => {
    const bootB = bootstrap(user('user-b'));
    const bootstrapFailure = new ApiError('NETWORK_ERROR', 'bootstrap offline', 0);
    let bootstrapCalls = 0;
    apiMock.post.mockImplementation(async (path: string) => {
      if (path === '/api/auth/login') return { user: user('user-b') };
      throw new Error(`Unexpected POST ${path}`);
    });
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/api/bootstrap') {
        bootstrapCalls += 1;
        if (bootstrapCalls <= 2) throw bootstrapFailure;
        return bootB;
      }
      if (path === '/api/workspace') return { tabs: [], activeId: '' };
      throw new Error(`Unexpected GET ${path}`);
    });

    await expect(useAppStore.getState().login('user-b', 'correct-pass')).rejects.toBe(
      bootstrapFailure,
    );
    expect(useAppStore.getState().ready).toBe(false);

    await useAppStore.getState().revalidateSession();

    expect(useAppStore.getState().ready).toBe(true);
    expect(useAppStore.getState().currentUser?.id).toBe('user-b');
    expect(getApiSessionSnapshot().userId).toBe('user-b');
    expect(isApiSessionFrozen()).toBe(false);
  });

  it('a false differing signal hides immediately but preserves A state and pending save', async () => {
    const gate = deferred<BootstrapInfo>();
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/api/bootstrap') return gate.promise;
      if (path === '/api/workspace') return { tabs: [], activeId: '' };
      throw new Error(`Unexpected GET ${path}`);
    });
    const workspace = useWorkspaceStore.getState();
    workspace.updateSql(workspace.activeId, 'SELECT false_signal_pending;');
    useUiStore.getState().setEditorPct(73);

    useAppStore.getState().handleSessionSignal('user-b');

    expect(useAppStore.getState().ready).toBe(false);
    expect(isApiSessionFrozen()).toBe(true);
    expect(useAppStore.getState().currentUser?.id).toBe('user-a');
    expect(workspaceSql()).toContain('false_signal_pending');
    expect(useWorkspaceStore.getState().ownerId).toBe('user-a');
    expect(useUiStore.getState()).toMatchObject({ ownerId: 'user-a', editorPct: 73 });

    gate.resolve(bootstrap(user('user-a')));
    await settle();

    expect(useAppStore.getState().ready).toBe(true);
    expect(useAppStore.getState().currentUser?.id).toBe('user-a');
    expect(workspaceSql()).toContain('false_signal_pending');
    expect(useUiStore.getState().editorPct).toBe(73);
    expect(isApiSessionFrozen()).toBe(false);

    await useWorkspaceStore.getState().flushForUser('user-a', getApiSessionSnapshot());
    expect(apiMock.put).toHaveBeenCalledWith(
      '/api/workspace',
      expect.objectContaining({
        tabs: expect.arrayContaining([
          expect.objectContaining({ sql: 'SELECT false_signal_pending;' }),
        ]),
      }),
      expect.objectContaining({ session: getApiSessionSnapshot() }),
    );
  });

  it('runs exactly one fresh probe for B after a differing signal makes a focus probe stale', async () => {
    const staleGate = deferred<BootstrapInfo>();
    const bootB = bootstrap(user('user-b'));
    let bootstrapCalls = 0;
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/api/bootstrap') {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return staleGate.promise;
        return bootB;
      }
      if (path === '/api/workspace') return { tabs: [], activeId: '' };
      throw new Error(`Unexpected GET ${path}`);
    });

    const focusProbe = useAppStore.getState().revalidateSession();
    await settle();
    useAppStore.getState().handleSessionSignal('user-b');
    expect(useAppStore.getState().ready).toBe(false);

    staleGate.resolve(bootstrap(user('user-a')));
    await focusProbe;
    await settle();

    expect(bootstrapCalls).toBe(2);
    expect(useAppStore.getState().currentUser?.id).toBe('user-b');
    expect(useAppStore.getState().ready).toBe(true);
    expect(getApiSessionSnapshot().userId).toBe('user-b');
  });

  it('logout flushes A, then clears and broadcasts only after server success', async () => {
    const workspace = useWorkspaceStore.getState();
    workspace.updateSql(workspace.activeId, 'SELECT logout_flush;');
    const callOrder: string[] = [];
    apiMock.put.mockImplementation(async (path: string) => {
      if (path === '/api/workspace') {
        callOrder.push('flush');
        return {};
      }
      throw new Error(`Unexpected PUT ${path}`);
    });
    apiMock.post.mockImplementation(async (path: string) => {
      if (path === '/api/auth/logout') {
        callOrder.push('logout');
        expect(useWorkspaceStore.getState().ownerId).toBe('user-a');
        expect(useAppStore.getState().currentUser?.id).toBe('user-a');
        return { ok: true };
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    await useAppStore.getState().logout();

    expect(callOrder).toEqual(['flush', 'logout']);
    expect(useAppStore.getState()).toMatchObject({ ready: true, currentUser: null });
    expect(useWorkspaceStore.getState().ownerId).toBeNull();
    expect(useUiStore.getState().ownerId).toBeNull();
    expect(getApiSessionSnapshot().userId).toBeNull();
    expect(isApiSessionFrozen()).toBe(false);
  });

  it('network logout failure restores A and keeps its state while rejecting actionably', async () => {
    const workspace = useWorkspaceStore.getState();
    workspace.updateSql(workspace.activeId, 'SELECT logout_network_kept;');
    useUiStore.getState().setEditorPct(74);
    apiMock.boot = bootstrap(user('user-a'));
    apiMock.post.mockImplementation(async (path: string) => {
      if (path === '/api/auth/logout') throw new ApiError('NETWORK_ERROR', 'offline', 0);
      throw new Error(`Unexpected POST ${path}`);
    });

    await expect(useAppStore.getState().logout()).rejects.toMatchObject({
      code: 'LOGOUT_FAILED',
      message: expect.stringContaining('session is still active'),
    });

    expect(useAppStore.getState()).toMatchObject({ ready: true });
    expect(useAppStore.getState().currentUser?.id).toBe('user-a');
    expect(getApiSessionSnapshot().userId).toBe('user-a');
    expect(isApiSessionFrozen()).toBe(false);
    expect(workspaceSql()).toContain('logout_network_kept');
    expect(useUiStore.getState()).toMatchObject({ ownerId: 'user-a', editorPct: 74 });
  });

  it('stale-owner logout reconciles B and rejects without forcing anonymous', async () => {
    apiMock.boot = bootstrap(user('user-b'));
    apiMock.post.mockImplementation(async (path: string) => {
      if (path === '/api/auth/logout') throw new SessionChangedError();
      throw new Error(`Unexpected POST ${path}`);
    });

    await expect(useAppStore.getState().logout()).rejects.toMatchObject({
      code: 'LOGOUT_SESSION_CHANGED',
    });

    expect(useAppStore.getState()).toMatchObject({ ready: true });
    expect(useAppStore.getState().currentUser?.id).toBe('user-b');
    expect(getApiSessionSnapshot().userId).toBe('user-b');
    expect(useWorkspaceStore.getState().ownerId).toBe('user-b');
    expect(useUiStore.getState().ownerId).toBe('user-b');
    expect(isApiSessionFrozen()).toBe(false);
  });
});
