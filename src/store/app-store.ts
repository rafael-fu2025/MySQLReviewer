import { create } from 'zustand';
import type {
  AppSettings,
  BootstrapInfo,
  ConnectResult,
  ConnectionProfile,
  DatabaseInfo,
  DatabaseObjects,
  DetectedXampp,
  PublicUser,
  SchemaSummary,
  ServerInfo,
  AiProvider,
  ThemePreference,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import {
  api,
  ApiError,
  beginApiSessionTransition,
  broadcastSessionChange,
  commitApiSession,
  getApiSessionSnapshot,
  isApiSessionCurrent,
  isSessionChangedError,
  setApiToken,
  setUnauthorizedHandler,
  type ApiSessionSnapshot,
} from '@/lib/api';
import { randomId } from '@/lib/uuid';
import { useWorkspaceStore } from './workspace-store';
import { useUiStore } from './ui-store';

/** The selected profile is remembered per signed-in user, not per browser. */
function activeProfileKey(userId: string | null): string | null {
  return userId ? `mylens.activeProfile.${encodeURIComponent(userId)}` : null;
}

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warn' | 'info';
}

interface AppState {
  ready: boolean;
  bootError: string | null;
  boot: BootstrapInfo | null;
  profiles: ConnectionProfile[];
  providers: AiProvider[];
  settings: AppSettings;
  detectedXampp: DetectedXampp | null;
  activeProfileId: string | null;
  server: ServerInfo | null;
  databases: DatabaseInfo[];
  selectedDatabase: string | null;
  schema: SchemaSummary | null;
  objects: DatabaseObjects | null;
  schemaLoading: boolean;
  unlockedUntil: number | null;
  toasts: Toast[];
  theme: ThemePreference;
  paletteOpen: boolean;
  currentUser: PublicUser | null;
  needsSetup: boolean;

  init: () => Promise<void>;
  /** Reconcile the cookie-backed identity after focus, page restore, or another tab's signal. */
  revalidateSession: () => Promise<void>;
  /** Abort old-account work and hide its shell before verifying a differing signal. */
  handleSessionSignal: (userId: string | null) => void;
  login: (username: string, password: string) => Promise<void>;
  setupAdmin: (username: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshCurrentUser: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  connect: (profileId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  setDatabase: (database: string) => void;
  refreshDatabases: () => Promise<void>;
  refreshSchema: (force?: boolean) => Promise<void>;
  refreshObjects: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setTheme: (theme: ThemePreference) => Promise<void>;
  unlockWrites: (phrase: string) => Promise<void>;
  lockWrites: () => Promise<void>;
  toast: (message: string, type?: Toast['type']) => void;
  dismissToast: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
}

let mediaListener: ((event: MediaQueryListEvent) => void) | null = null;
let initStarted = false;
let sessionGeneration = 0;
let appGeneration = 0;
let revalidationPromise: Promise<void> | null = null;
let revalidationEpoch: number | null = null;
let revalidationFollowUp = false;
let revalidationForcedDuringLogout = false;
let logoutPromise: Promise<void> | null = null;
const operationGenerations = new Map<string, number>();

interface OperationGuard {
  app: number;
  operation: string;
  operationGeneration: number;
  session: ApiSessionSnapshot;
}

function beginOperation(operation: string): OperationGuard {
  const operationGeneration = (operationGenerations.get(operation) ?? 0) + 1;
  operationGenerations.set(operation, operationGeneration);
  return {
    app: appGeneration,
    operation,
    operationGeneration,
    session: getApiSessionSnapshot(),
  };
}

function operationIsCurrent(guard: OperationGuard): boolean {
  return (
    guard.app === appGeneration &&
    operationGenerations.get(guard.operation) === guard.operationGeneration &&
    isApiSessionCurrent(guard.session)
  );
}

/** Invalidate every store-level continuation before clearing an identity. */
function invalidateOperations(): void {
  appGeneration += 1;
  operationGenerations.clear();
}

function applyTheme(theme: ThemePreference): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const paint = (): void => {
    const dark = theme === 'dark' || (theme === 'system' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  paint();
  if (mediaListener) {
    media.removeEventListener('change', mediaListener);
    mediaListener = null;
  }
  if (theme === 'system') {
    mediaListener = () => paint();
    media.addEventListener('change', mediaListener);
  }
}

function firstUserDatabase(profile: ConnectionProfile, databases: DatabaseInfo[]): string | null {
  if (profile.database && databases.some((database) => database.name === profile.database)) {
    return profile.database;
  }
  return databases.find((database) => !database.isSystem)?.name ?? databases[0]?.name ?? null;
}

function clientError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStoredProfile(userId: string): string | null {
  const key = activeProfileKey(userId);
  try {
    return key ? (getLocalStorage()?.getItem(key) ?? null) : null;
  } catch {
    return null;
  }
}

function writeStoredProfile(userId: string | null, profileId: string | null): void {
  const key = activeProfileKey(userId);
  if (!key) return;
  try {
    if (profileId) getLocalStorage()?.setItem(key, profileId);
    else getLocalStorage()?.removeItem(key);
  } catch {
    // Browser storage is an optimization; session isolation does not rely on it.
  }
}

function removeLegacyProfileKey(): void {
  try {
    getLocalStorage()?.removeItem('mylens.activeProfile');
  } catch {
    // Nothing to migrate when storage is unavailable.
  }
}

function blankSensitiveState(): Pick<
  AppState,
  | 'ready'
  | 'bootError'
  | 'boot'
  | 'profiles'
  | 'providers'
  | 'settings'
  | 'detectedXampp'
  | 'activeProfileId'
  | 'server'
  | 'databases'
  | 'selectedDatabase'
  | 'schema'
  | 'objects'
  | 'schemaLoading'
  | 'unlockedUntil'
  | 'toasts'
  | 'paletteOpen'
  | 'currentUser'
  | 'needsSetup'
> {
  return {
    ready: false,
    bootError: null,
    boot: null,
    profiles: [],
    providers: [],
    settings: { ...DEFAULT_SETTINGS },
    detectedXampp: null,
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
    currentUser: null,
    needsSetup: false,
  };
}

/**
 * Fetch the objects of one database without touching the global store. The
 * practice page is pinned to its set's database, which can differ from the
 * top-bar selection, so it must not call `refreshObjects` (that writes
 * `objects` for `selectedDatabase`). api.ts still pins this request to the
 * current account epoch, so a result from A rejects instead of reaching B.
 */
export async function loadObjects(profileId: string, database: string): Promise<DatabaseObjects> {
  return api.get<DatabaseObjects>(
    `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/objects`,
  );
}

export const useAppStore = create<AppState>((set, get) => {
  const clearForTransition = (): void => {
    invalidateOperations();
    useWorkspaceStore.getState().hydrateForUser(null);
    useUiStore.getState().hydrateForUser(null);
    set(blankSensitiveState());
  };

  /**
   * Freeze and hide account surfaces without erasing any A-owned state. This is
   * used when a cross-tab signal or logout may be stale: bootstrap must verify
   * the cookie before stores are either restored for A or replaced by B.
   */
  const freezeForVerification = (expectedUserId: string | null): ApiSessionSnapshot => {
    sessionGeneration += 1;
    invalidateOperations();
    const transition = beginApiSessionTransition(expectedUserId);
    set({ ready: false, bootError: null, paletteOpen: false });
    return transition;
  };

  const applySameUserBootstrap = (boot: BootstrapInfo): void => {
    const user = boot.currentUser;
    if (!user) return;
    const previousTheme = get().theme;
    const activeProfileId = get().activeProfileId;
    const activeStillAllowed =
      activeProfileId === null || boot.profiles.some((profile) => profile.id === activeProfileId);

    set({
      boot,
      bootError: null,
      ready: true,
      profiles: boot.profiles,
      providers: boot.providers,
      settings: boot.settings,
      detectedXampp: boot.detectedXampp,
      theme: boot.settings.theme,
      currentUser: user,
      needsSetup: boot.auth.needsSetup,
      ...(activeStillAllowed
        ? {}
        : {
            activeProfileId: null,
            server: null,
            databases: [],
            selectedDatabase: null,
            schema: null,
            objects: null,
            schemaLoading: false,
            unlockedUntil: null,
          }),
    });
    setApiToken(boot.token);
    if (!activeStillAllowed) writeStoredProfile(user.id, null);
    if (previousTheme !== boot.settings.theme) applyTheme(boot.settings.theme);
  };

  const restoreProfile = async (boot: BootstrapInfo): Promise<void> => {
    const user = boot.currentUser;
    if (!user) return;
    const stored = readStoredProfile(user.id);
    if (!stored || !boot.profiles.some((profile) => profile.id === stored)) return;
    try {
      await get().connect(stored);
    } catch (error) {
      if (isSessionChangedError(error)) return;
      writeStoredProfile(user.id, null);
      get().toast(`Could not reconnect: ${clientError(error)}`, 'warn');
    }
  };

  /**
   * Publish a bootstrap in one store update only after its account has been
   * verified. The API epoch is unfrozen first so mounted effects cannot race a
   * still-frozen transport. Workspace/UI hydration happens while `ready` was
   * false, so no outgoing account state can flash in B's shell.
   */
  const publishBootstrap = async (
    boot: BootstrapInfo,
    session: ApiSessionSnapshot,
  ): Promise<void> => {
    const userId = boot.currentUser?.id ?? null;
    if (session.userId !== userId) {
      throw new ApiError(
        'SESSION_VERIFICATION_FAILED',
        'The server session changed while MyLens was verifying the account.',
        409,
      );
    }
    setApiToken(boot.currentUser ? boot.token : '');
    commitApiSession(session);
    removeLegacyProfileKey();
    useUiStore.getState().hydrateForUser(userId);
    useWorkspaceStore.getState().hydrateForUser(userId, session);

    const authenticated = boot.currentUser !== null;
    set({
      ready: true,
      bootError: null,
      boot,
      profiles: authenticated ? boot.profiles : [],
      providers: authenticated ? boot.providers : [],
      settings: authenticated ? boot.settings : { ...DEFAULT_SETTINGS },
      detectedXampp: boot.detectedXampp,
      theme: authenticated ? boot.settings.theme : 'dark',
      currentUser: boot.currentUser,
      needsSetup: boot.auth.needsSetup,
    });
    // A signed-in theme comes only from the verified bootstrap. The anonymous
    // sign-in screen owns its separate browser-level auth theme.
    if (authenticated) applyTheme(boot.settings.theme);
    await restoreProfile(boot);
  };

  const bootstrapTransition = async (
    transition: ApiSessionSnapshot,
    expectedUserId?: string,
  ): Promise<void> => {
    const generation = sessionGeneration;
    const boot = await api.get<BootstrapInfo>('/api/bootstrap', {
      session: transition,
      allowDuringTransition: true,
      // Bootstrap is the identity discovery endpoint. Sending the old expected
      // user here would make an A -> B cookie change impossible to discover.
      includeExpectedUser: false,
    });
    if (generation !== sessionGeneration || !isApiSessionCurrent(transition, true)) {
      throw new ApiError('SESSION_CHANGED', 'A newer session check replaced this one.', 409);
    }
    if (expectedUserId && boot.currentUser?.id !== expectedUserId) {
      throw new ApiError(
        'SESSION_VERIFICATION_FAILED',
        'Sign-in succeeded, but the verified bootstrap belongs to a different account.',
        409,
      );
    }

    const resolvedUserId = boot.currentUser?.id ?? null;
    const resolvedSession =
      transition.userId === resolvedUserId ? transition : beginApiSessionTransition(resolvedUserId);
    await publishBootstrap(boot, resolvedSession);
  };

  const revalidate = async (forceDuringLogout = false): Promise<void> => {
    if (logoutPromise && !forceDuringLogout) return logoutPromise;
    const requestedEpoch = getApiSessionSnapshot().epoch;
    if (revalidationPromise) {
      if (revalidationEpoch !== requestedEpoch) revalidationFollowUp = true;
      if (forceDuringLogout) revalidationForcedDuringLogout = true;
      return revalidationPromise;
    }

    revalidationForcedDuringLogout = forceDuringLogout;

    const runProbe = async (): Promise<void> => {
      const probedFrom = getApiSessionSnapshot();
      revalidationEpoch = probedFrom.epoch;
      const wasTransitioning =
        isApiSessionCurrent(probedFrom, true) && !isApiSessionCurrent(probedFrom);
      // This is deliberately not an epoch transition: routine focus/pageshow
      // checks must not abort requests, blank stores, cancel debounced saves, or
      // display the splash. Bootstrap alone is allowed to discover the cookie
      // identity without an expected-user assertion.
      const boot = await api.get<BootstrapInfo>('/api/bootstrap', {
        session: probedFrom,
        includeExpectedUser: false,
        bypassSessionGuard: true,
      });

      // Another operation (login/logout/signal handling) already moved the
      // client while this probe was in flight. Queue one fresh probe for that
      // epoch; never let an old probe thaw or publish it.
      const current = getApiSessionSnapshot();
      if (current.epoch !== probedFrom.epoch || current.userId !== probedFrom.userId) {
        revalidationFollowUp = true;
        return;
      }

      const resolvedUserId = boot.currentUser?.id ?? null;
      const liveUserId = get().currentUser?.id ?? null;
      const settledSameUser =
        resolvedUserId === probedFrom.userId && get().ready && liveUserId === resolvedUserId;
      if (settledSameUser) {
        if (wasTransitioning) commitApiSession(probedFrom);
        applySameUserBootstrap(boot);
        return;
      }

      if (resolvedUserId === probedFrom.userId) {
        if (wasTransitioning) commitApiSession(probedFrom);
        await publishBootstrap(boot, probedFrom);
        return;
      }

      const transition = freezeForVerification(resolvedUserId);
      try {
        await publishBootstrap(boot, transition);
      } catch (error) {
        if (isApiSessionCurrent(transition, true)) {
          set({ ready: true, bootError: clientError(error) });
        }
        throw error;
      }
    };

    const run = (async () => {
      do {
        revalidationFollowUp = false;
        await runProbe();
      } while (revalidationFollowUp && (!logoutPromise || revalidationForcedDuringLogout));
    })();

    revalidationPromise = run;
    try {
      await run;
    } finally {
      if (revalidationPromise === run) {
        revalidationPromise = null;
        revalidationEpoch = null;
        revalidationFollowUp = false;
        revalidationForcedDuringLogout = false;
      }
    }
  };

  const authenticate = async (
    path: '/api/auth/login' | '/api/auth/setup',
    credentials: Record<string, string>,
  ): Promise<void> => {
    // Freeze before the cookie-mutating request starts. In particular, an A
    // workspace autosave cannot leave concurrently and arrive after login has
    // changed the cookie to B.
    sessionGeneration += 1;
    const outgoingUserId = getApiSessionSnapshot().userId;
    const transition = beginApiSessionTransition(outgoingUserId);
    clearForTransition();
    try {
      const result = await api.post<{ user: PublicUser }>(path, credentials, {
        session: transition,
        allowDuringTransition: true,
        includeExpectedUser: false,
      });
      sessionGeneration += 1;
      const verifiedUser = beginApiSessionTransition(result.user.id);
      await bootstrapTransition(verifiedUser, result.user.id);
      broadcastSessionChange(result.user.id);
    } catch (error) {
      // Reconcile whatever cookie the server ended up with, without ever
      // publishing the unverified login response as currentUser. Thaw this
      // failed auth transition so the nondestructive probe can run; it keeps
      // state blank until bootstrap verifies whichever cookie survived.
      const current = getApiSessionSnapshot();
      if (isApiSessionCurrent(current, true) && !isApiSessionCurrent(current)) {
        commitApiSession(current);
      }
      try {
        await revalidate();
      } catch {
        // The original auth/bootstrap failure is the actionable one. If login
        // changed the cookie to B but its first bootstrap failed, keep the shell
        // hidden; a later focus/signal probe can safely publish B.
      }
      throw error;
    }
  };

  return {
    ready: false,
    bootError: null,
    boot: null,
    profiles: [],
    providers: [],
    settings: { ...DEFAULT_SETTINGS },
    detectedXampp: null,
    activeProfileId: null,
    server: null,
    databases: [],
    selectedDatabase: null,
    schema: null,
    objects: null,
    schemaLoading: false,
    unlockedUntil: null,
    toasts: [],
    theme: 'dark',
    paletteOpen: false,
    currentUser: null,
    needsSetup: false,

    init: async () => {
      if (initStarted) return;
      initStarted = true;
      setUnauthorizedHandler(() => {
        // api.ts freezes synchronously before invoking this handler; the probe
        // below verifies the cookie without disturbing same-user state.
        void get()
          .revalidateSession()
          .catch(() => undefined);
      });
      sessionGeneration += 1;
      const initial = beginApiSessionTransition(getApiSessionSnapshot().userId);
      clearForTransition();
      try {
        await bootstrapTransition(initial);
      } catch (error) {
        set({ bootError: clientError(error), ready: true });
      }
    },

    revalidateSession: revalidate,

    handleSessionSignal: (userId) => {
      const current = getApiSessionSnapshot();
      if (userId !== current.userId) {
        // The signal is only a hint, not proof. Abort and hide synchronously, but
        // retain A's workspace, UI, connection and pending save until bootstrap
        // verifies whether the cookie is still A or has actually become B.
        freezeForVerification(current.userId);
      }
      void revalidate().catch(() => undefined);
    },

    login: async (username, password) => {
      await authenticate('/api/auth/login', { username, password });
    },

    setupAdmin: async (username, displayName, password) => {
      await authenticate('/api/auth/setup', { username, displayName, password });
    },

    logout: async () => {
      if (logoutPromise) return logoutPromise;
      const user = get().currentUser;
      if (!user) return;
      const run = (async () => {
        // Flush A while its settled transport is still usable. Account surfaces
        // are hidden immediately, but stores and connection context remain intact
        // until the server confirms that A's cookie was actually cleared.
        set({ ready: false, bootError: null, paletteOpen: false });
        const settledSession = getApiSessionSnapshot();
        try {
          await useWorkspaceStore.getState().flushForUser(user.id, settledSession);
        } catch (error) {
          set({ ready: true });
          throw new ApiError(
            'WORKSPACE_SAVE_FAILED',
            `Could not save the workspace, so sign-out was cancelled: ${clientError(error)}`,
            503,
          );
        }

        const outgoing = freezeForVerification(user.id);
        try {
          await api.post(
            '/api/auth/logout',
            {},
            {
              session: outgoing,
              allowDuringTransition: true,
              expectedUserId: user.id,
            },
          );
        } catch (error) {
          if (isSessionChangedError(error)) {
            // A stale-owner response means another tab changed the shared cookie.
            // Verify and publish that account instead of clearing it locally or
            // broadcasting a false anonymous state.
            try {
              await revalidate(true);
            } catch (reconcileError) {
              throw new ApiError(
                'LOGOUT_RECONCILE_FAILED',
                `The signed-in account changed while signing out, and MyLens could not refresh it: ${clientError(reconcileError)}`,
                409,
              );
            }
            throw new ApiError(
              'LOGOUT_SESSION_CHANGED',
              'The signed-in account changed in another tab. MyLens refreshed the current account instead of signing it out.',
              409,
            );
          }

          // Network/server failures do not prove the cookie was cleared. Verify
          // it; the normal case republishes A and retags its pending workspace.
          try {
            await revalidate(true);
          } catch {
            if (isApiSessionCurrent(outgoing, true)) {
              commitApiSession(outgoing);
              set({ ready: true, bootError: null });
            }
          }
          throw new ApiError(
            'LOGOUT_FAILED',
            `Could not sign out. Your session is still active: ${clientError(error)}`,
            error instanceof ApiError && error.status > 0 ? error.status : 503,
          );
        }

        // Only a successful server response proves the cookie is anonymous.
        const anonymous = beginApiSessionTransition(null);
        setApiToken('');
        useWorkspaceStore.getState().hydrateForUser(null, anonymous);
        useUiStore.getState().hydrateForUser(null);
        commitApiSession(anonymous);
        set({ ...blankSensitiveState(), ready: true });
        writeStoredProfile(user.id, null);
        broadcastSessionChange(null);
      })();
      logoutPromise = run;
      try {
        await run;
      } finally {
        if (logoutPromise === run) logoutPromise = null;
      }
    },

    refreshCurrentUser: async () => {
      await get().revalidateSession();
    },

    refreshProfiles: async () => {
      const guard = beginOperation('profiles');
      const profiles = await api.get<ConnectionProfile[]>('/api/connections', {
        session: guard.session,
      });
      if (operationIsCurrent(guard)) set({ profiles });
    },

    refreshProviders: async () => {
      const guard = beginOperation('providers');
      const providers = await api.get<AiProvider[]>('/api/ai/providers', {
        session: guard.session,
      });
      if (operationIsCurrent(guard)) set({ providers });
    },

    refreshSettings: async () => {
      const guard = beginOperation('settings');
      const settings = await api.get<AppSettings>('/api/settings', { session: guard.session });
      if (!operationIsCurrent(guard)) return;
      set({ settings, theme: settings.theme });
      applyTheme(settings.theme);
    },

    connect: async (profileId) => {
      const guard = beginOperation('connection');
      const result = await api.post<ConnectResult>(
        `/api/connections/${profileId}/connect`,
        {},
        { session: guard.session },
      );
      if (!operationIsCurrent(guard)) return;
      const profile =
        get().profiles.find((item) => item.id === profileId) ??
        (
          await api.get<ConnectionProfile[]>('/api/connections', {
            session: guard.session,
          })
        ).find((item) => item.id === profileId);
      if (!operationIsCurrent(guard)) return;
      const database = profile ? firstUserDatabase(profile, result.databases) : null;
      set({
        activeProfileId: profileId,
        server: result.server,
        databases: result.databases,
        selectedDatabase: database,
        schema: null,
        objects: null,
        unlockedUntil: result.unlock.unlocked ? Date.parse(result.unlock.until ?? '') : null,
      });
      writeStoredProfile(guard.session.userId, profileId);
      void get()
        .refreshProfiles()
        .catch(() => undefined);
      void get().refreshSchema();
      void get().refreshObjects();
    },

    disconnect: async () => {
      const id = get().activeProfileId;
      const guard = beginOperation('connection');
      if (id) {
        try {
          await api.post(`/api/connections/${id}/disconnect`, {}, { session: guard.session });
        } catch (error) {
          if (isSessionChangedError(error)) return;
          // The local state still needs to be cleared for a same-session failure.
        }
      }
      if (!operationIsCurrent(guard)) return;
      writeStoredProfile(guard.session.userId, null);
      set({
        activeProfileId: null,
        server: null,
        databases: [],
        selectedDatabase: null,
        schema: null,
        objects: null,
        unlockedUntil: null,
      });
    },

    setDatabase: (database) => {
      if (database === get().selectedDatabase) return;
      // Supersede continuations for the old database before launching the new ones.
      operationGenerations.set('schema', (operationGenerations.get('schema') ?? 0) + 1);
      operationGenerations.set('objects', (operationGenerations.get('objects') ?? 0) + 1);
      set({ selectedDatabase: database, schema: null, objects: null });
      void get().refreshSchema();
      void get().refreshObjects();
    },

    refreshDatabases: async () => {
      const id = get().activeProfileId;
      if (!id) return;
      const guard = beginOperation('databases');
      const databases = await api.get<DatabaseInfo[]>(`/api/db/${id}/databases`, {
        session: guard.session,
      });
      if (!operationIsCurrent(guard) || get().activeProfileId !== id) return;
      const selected = get().selectedDatabase;
      const stillExists = selected && databases.some((database) => database.name === selected);
      set({
        databases,
        selectedDatabase: stillExists
          ? selected
          : (databases.find((database) => !database.isSystem)?.name ?? null),
      });
    },

    refreshSchema: async (force = false) => {
      const { activeProfileId, selectedDatabase } = get();
      if (!activeProfileId || !selectedDatabase) {
        operationGenerations.set('schema', (operationGenerations.get('schema') ?? 0) + 1);
        set({ schema: null, schemaLoading: false });
        return;
      }
      const guard = beginOperation('schema');
      set({ schemaLoading: true });
      try {
        if (force) {
          await api.post(
            `/api/db/${activeProfileId}/schema/refresh`,
            { database: selectedDatabase },
            { session: guard.session },
          );
        }
        const schema = await api.get<SchemaSummary>(
          `/api/db/${activeProfileId}/schema?database=${encodeURIComponent(selectedDatabase)}`,
          { session: guard.session },
        );
        if (
          operationIsCurrent(guard) &&
          get().activeProfileId === activeProfileId &&
          get().selectedDatabase === selectedDatabase
        ) {
          set({ schema });
        }
      } catch (error) {
        if (operationIsCurrent(guard)) {
          get().toast(`Schema refresh failed: ${clientError(error)}`, 'warn');
        }
      } finally {
        if (operationIsCurrent(guard)) set({ schemaLoading: false });
      }
    },

    refreshObjects: async () => {
      const { activeProfileId, selectedDatabase } = get();
      if (!activeProfileId || !selectedDatabase) {
        operationGenerations.set('objects', (operationGenerations.get('objects') ?? 0) + 1);
        set({ objects: null });
        return;
      }
      const guard = beginOperation('objects');
      try {
        const objects = await api.get<DatabaseObjects>(
          `/api/db/${activeProfileId}/databases/${encodeURIComponent(selectedDatabase)}/objects`,
          { session: guard.session },
        );
        if (
          operationIsCurrent(guard) &&
          get().activeProfileId === activeProfileId &&
          get().selectedDatabase === selectedDatabase
        ) {
          set({ objects });
        }
      } catch {
        // The table list may be temporarily unavailable while a schema is dropped.
      }
    },

    updateSettings: async (patch) => {
      const guard = beginOperation('settings');
      const settings = await api.put<AppSettings>('/api/settings', patch, {
        session: guard.session,
      });
      if (!operationIsCurrent(guard)) return;
      set({ settings, theme: settings.theme });
      applyTheme(settings.theme);
    },

    setTheme: async (theme) => {
      const guard = beginOperation('theme');
      set({ theme });
      applyTheme(theme);
      try {
        await api.put<{ theme: ThemePreference }>(
          '/api/settings/theme',
          { theme },
          { session: guard.session },
        );
        if (!operationIsCurrent(guard)) return;
        set((state) => ({
          currentUser: state.currentUser ? { ...state.currentUser, theme } : state.currentUser,
          settings: { ...state.settings, theme },
        }));
      } catch (error) {
        if (operationIsCurrent(guard)) {
          get().toast(`Could not save the theme: ${clientError(error)}`, 'warn');
        }
      }
    },

    unlockWrites: async (phrase) => {
      const id = get().activeProfileId;
      if (!id) return;
      const guard = beginOperation('write-lock');
      const result = await api.post<{ unlocked: boolean; until: string | null }>(
        `/api/connections/${id}/unlock`,
        { phrase },
        { session: guard.session },
      );
      if (!operationIsCurrent(guard) || get().activeProfileId !== id) return;
      set({ unlockedUntil: result.unlocked ? Date.parse(result.until ?? '') : null });
      get().toast('Writes unlocked for this connection for 15 minutes.', 'warn');
    },

    lockWrites: async () => {
      const id = get().activeProfileId;
      if (!id) return;
      const guard = beginOperation('write-lock');
      try {
        await api.post(`/api/connections/${id}/lock`, {}, { session: guard.session });
      } catch (error) {
        if (isSessionChangedError(error)) return;
        // Clearing local state still re-locks the UI for a same-session failure.
      }
      if (!operationIsCurrent(guard) || get().activeProfileId !== id) return;
      set({ unlockedUntil: null });
      get().toast('Writes locked.', 'success');
    },

    toast: (message, type = 'info') => {
      const id = randomId();
      const toastGeneration = appGeneration;
      set((state) => ({
        toasts: [...state.toasts.slice(-3), { id, message, type }],
      }));
      setTimeout(
        () => {
          if (toastGeneration === appGeneration) get().dismissToast(id);
        },
        type === 'error' ? 8_000 : 5_000,
      );
    },

    dismissToast: (id) => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },

    setPaletteOpen: (open) => set({ paletteOpen: open }),
  };
});
