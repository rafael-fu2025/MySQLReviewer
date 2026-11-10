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
import { api, ApiError, setApiToken, setUnauthorizedHandler } from '@/lib/api';
import { randomId } from '@/lib/uuid';
import { useWorkspaceStore } from './workspace-store';

/** The selected profile is remembered per signed-in user, not per browser. */
function activeProfileKey(userId: string | null): string | null {
  return userId ? `mylens.activeProfile.${userId}` : null;
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
  login: (username: string, password: string) => Promise<void>;
  setupAdmin: (username: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshCurrentUser: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  connect: (profileId: string, password?: string) => Promise<void>;
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

function applyTheme(theme: ThemePreference): void {
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

/**
 * Fetch the objects of one database without touching the global store. The
 * practice page is pinned to its set's database, which can differ from the
 * top-bar selection, so it must not call `refreshObjects` (that writes
 * `objects` for `selectedDatabase`).
 */
export async function loadObjects(profileId: string, database: string): Promise<DatabaseObjects> {
  return api.get<DatabaseObjects>(
    `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/objects`,
  );
}

export const useAppStore = create<AppState>((set, get) => ({
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
      get().toast('The local session expired after a server restart. Reloading…', 'error');
      setTimeout(() => window.location.reload(), 900);
    });
    try {
      const boot = await api.get<BootstrapInfo>('/api/bootstrap');
      setApiToken(boot.token);
      set({
        boot,
        profiles: boot.profiles,
        providers: boot.providers,
        settings: boot.settings,
        detectedXampp: boot.detectedXampp,
        theme: boot.settings.theme,
        currentUser: boot.currentUser,
        needsSetup: boot.auth.needsSetup,
        bootError: null,
      });
      applyTheme(boot.settings.theme);

      // The workspace belongs to the account, not the browser: swap in this
      // user's persisted tabs before anything restores a profile.
      useWorkspaceStore.getState().hydrateForUser(boot.currentUser?.id ?? null);
      // The pre-multiuser build remembered the profile in one global key.
      try {
        localStorage.removeItem('mylens.activeProfile');
      } catch {
        // Storage unavailable; nothing to clean up.
      }
      const bootUser = boot.currentUser;
      const activeKey = activeProfileKey(bootUser?.id ?? null);
      const stored = activeKey ? localStorage.getItem(activeKey) : null;
      if (stored && boot.profiles.some((profile) => profile.id === stored)) {
        try {
          await get().connect(stored);
        } catch (error) {
          if (activeKey) localStorage.removeItem(activeKey);
          get().toast(`Could not reconnect: ${clientError(error)}`, 'warn');
        }
      }
      set({ ready: true });
    } catch (error) {
      set({
        bootError: clientError(error),
        ready: true,
      });
    }
  },

  login: async (username, password) => {
    const result = await api.post<{ user: PublicUser }>('/api/auth/login', {
      username,
      password,
    });
    const theme = result.user.theme ?? get().settings.theme;
    set({ currentUser: result.user, needsSetup: false, theme });
    applyTheme(theme);
    useWorkspaceStore.getState().hydrateForUser(result.user.id);
    // The anonymous bootstrap deliberately withholds the API token, the profile
    // list and the AI providers, and its profile list is unscoped. Re-read it
    // now that the session cookie exists so the client picks up the token and
    // the server-scoped lists.
    const boot = await api.get<BootstrapInfo>('/api/bootstrap');
    setApiToken(boot.token);
    set({
      boot,
      profiles: boot.profiles,
      providers: boot.providers,
      settings: boot.settings,
      currentUser: boot.currentUser ?? result.user,
    });
  },

  setupAdmin: async (username, displayName, password) => {
    const result = await api.post<{ user: PublicUser }>('/api/auth/setup', {
      username,
      displayName,
      password,
    });
    const theme = result.user.theme ?? get().theme;
    set({ currentUser: result.user, needsSetup: false, theme });
    applyTheme(theme);
    useWorkspaceStore.getState().hydrateForUser(result.user.id);
    const boot = await api.get<BootstrapInfo>('/api/bootstrap');
    setApiToken(boot.token);
    set({
      boot,
      profiles: boot.profiles,
      providers: boot.providers,
      settings: boot.settings,
      currentUser: boot.currentUser ?? result.user,
    });
  },

  logout: async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // Clearing local state matters more than the server round trip.
    }
    const user = get().currentUser;
    const activeKey = activeProfileKey(user?.id ?? null);
    if (activeKey) localStorage.removeItem(activeKey);
    // Hand the workspace back to nobody: tabs, SQL and AI threads must not
    // leak into the next account that signs in on this browser.
    useWorkspaceStore.getState().hydrateForUser(null);
    // The token was issued to a signed-in session; drop it so a signed-out
    // client holds no pre-session credential.
    setApiToken('');
    set({
      currentUser: null,
      activeProfileId: null,
      server: null,
      databases: [],
      selectedDatabase: null,
      schema: null,
      objects: null,
      unlockedUntil: null,
    });
  },

  refreshCurrentUser: async () => {
    const result = await api.get<{ user: PublicUser | null }>('/api/auth/me');
    set({ currentUser: result.user });
  },

  refreshProfiles: async () => {
    const profiles = await api.get<ConnectionProfile[]>('/api/connections');
    set({ profiles });
  },

  refreshProviders: async () => {
    const providers = await api.get<AiProvider[]>('/api/ai/providers');
    set({ providers });
  },

  refreshSettings: async () => {
    const settings = await api.get<AppSettings>('/api/settings');
    set({ settings, theme: settings.theme });
    applyTheme(settings.theme);
  },

  connect: async (profileId, password) => {
    const result = await api.post<ConnectResult>(`/api/connections/${profileId}/connect`, {
      ...(password !== undefined ? { password } : {}),
    });
    const profile =
      get().profiles.find((item) => item.id === profileId) ??
      (await api.get<ConnectionProfile[]>(`/api/connections`)).find(
        (item) => item.id === profileId,
      );
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
    const user = get().currentUser;
    const activeKey = activeProfileKey(user?.id ?? null);
    if (activeKey) localStorage.setItem(activeKey, profileId);
    void get().refreshProfiles();
    void get().refreshSchema();
    void get().refreshObjects();
  },

  disconnect: async () => {
    const id = get().activeProfileId;
    if (id) {
      try {
        await api.post(`/api/connections/${id}/disconnect`);
      } catch {
        // The local state still needs to be cleared.
      }
    }
    const user = get().currentUser;
    const activeKey = activeProfileKey(user?.id ?? null);
    if (activeKey) localStorage.removeItem(activeKey);
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
    set({ selectedDatabase: database, schema: null, objects: null });
    void get().refreshSchema();
    void get().refreshObjects();
  },

  refreshDatabases: async () => {
    const id = get().activeProfileId;
    if (!id) return;
    const databases = await api.get<DatabaseInfo[]>(`/api/db/${id}/databases`);
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
      set({ schema: null });
      return;
    }
    set({ schemaLoading: true });
    try {
      if (force) {
        await api.post(`/api/db/${activeProfileId}/schema/refresh`, {
          database: selectedDatabase,
        });
      }
      const schema = await api.get<SchemaSummary>(
        `/api/db/${activeProfileId}/schema?database=${encodeURIComponent(selectedDatabase)}`,
      );
      if (get().selectedDatabase === selectedDatabase) set({ schema });
    } catch (error) {
      get().toast(`Schema refresh failed: ${clientError(error)}`, 'warn');
    } finally {
      set({ schemaLoading: false });
    }
  },

  refreshObjects: async () => {
    const { activeProfileId, selectedDatabase } = get();
    if (!activeProfileId || !selectedDatabase) {
      set({ objects: null });
      return;
    }
    try {
      const objects = await api.get<DatabaseObjects>(
        `/api/db/${activeProfileId}/databases/${encodeURIComponent(selectedDatabase)}/objects`,
      );
      if (get().selectedDatabase === selectedDatabase) set({ objects });
    } catch {
      // The table list may be temporarily unavailable while a schema is dropped.
    }
  },

  updateSettings: async (patch) => {
    const settings = await api.put<AppSettings>('/api/settings', patch);
    set({ settings, theme: settings.theme });
    applyTheme(settings.theme);
  },

  setTheme: async (theme) => {
    set({ theme });
    applyTheme(theme);
    try {
      await api.put<{ theme: ThemePreference }>('/api/settings/theme', { theme });
      set((state) => ({
        currentUser: state.currentUser ? { ...state.currentUser, theme } : state.currentUser,
      }));
    } catch (error) {
      get().toast(`Could not save the theme: ${clientError(error)}`, 'warn');
    }
  },

  unlockWrites: async (phrase) => {
    const id = get().activeProfileId;
    if (!id) return;
    const result = await api.post<{ unlocked: boolean; until: string | null }>(
      `/api/connections/${id}/unlock`,
      { phrase },
    );
    set({ unlockedUntil: result.unlocked ? Date.parse(result.until ?? '') : null });
    get().toast('Writes unlocked for this connection for 15 minutes.', 'warn');
  },

  lockWrites: async () => {
    const id = get().activeProfileId;
    if (!id) return;
    try {
      await api.post(`/api/connections/${id}/lock`);
    } catch {
      // Clearing local state still re-locks the UI.
    }
    set({ unlockedUntil: null });
    get().toast('Writes locked.', 'success');
  },

  toast: (message, type = 'info') => {
    const id = randomId();
    set((state) => ({
      toasts: [...state.toasts.slice(-3), { id, message, type }],
    }));
    setTimeout(() => get().dismissToast(id), type === 'error' ? 8_000 : 5_000);
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  setPaletteOpen: (open) => set({ paletteOpen: open }),
}));
