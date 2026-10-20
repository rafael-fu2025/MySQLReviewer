import { create } from 'zustand';
import type {
  AppSettings,
  BootstrapInfo,
  ConnectResult,
  ConnectionProfile,
  DatabaseInfo,
  DatabaseObjects,
  DetectedXampp,
  SchemaSummary,
  ServerInfo,
  AiProvider,
  ThemePreference,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { api, ApiError, setApiToken, setUnauthorizedHandler } from '@/lib/api';

const ACTIVE_KEY = 'mylens.activeProfile';

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

  init: () => Promise<void>;
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
export async function loadObjects(
  profileId: string,
  database: string,
): Promise<DatabaseObjects> {
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
        bootError: null,
      });
      applyTheme(boot.settings.theme);

      const stored = localStorage.getItem(ACTIVE_KEY);
      if (stored && boot.profiles.some((profile) => profile.id === stored)) {
        try {
          await get().connect(stored);
        } catch (error) {
          localStorage.removeItem(ACTIVE_KEY);
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
    localStorage.setItem(ACTIVE_KEY, profileId);
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
    localStorage.removeItem(ACTIVE_KEY);
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
      await get().updateSettings({ theme });
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
    const id = crypto.randomUUID();
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
