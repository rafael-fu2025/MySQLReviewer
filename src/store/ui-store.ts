import { create } from 'zustand';
import type { FormatOptions } from '@/lib/sql-snippets';
import { DEFAULT_FORMAT_OPTIONS } from '@/lib/sql-snippets';

interface UiState {
  sidebarCollapsed: boolean;
  schemaCollapsed: boolean;
  editorPct: number;
  resultsMaximized: boolean;
  compactDensity: boolean;
  /** SQL formatter preferences, persisted with the owning user's layout. */
  formatKeywordCase: FormatOptions['keywordCase'];
  formatIndent: FormatOptions['indent'];
  formatLinesBetweenQueries: FormatOptions['linesBetweenQueries'];
  /** The account whose preferences are active; null means safe defaults. */
  ownerId: string | null;
  /** Explicit account hydration; no persisted middleware may run before identity. */
  hydrateForUser: (userId: string | null) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (value: boolean) => void;
  toggleSchema: () => void;
  setSchemaCollapsed: (value: boolean) => void;
  setEditorPct: (value: number) => void;
  toggleResultsMaximized: () => void;
  setResultsMaximized: (value: boolean) => void;
  setCompactDensity: (value: boolean) => void;
  setFormatOptions: (patch: Partial<FormatOptions>) => void;
  resetLayout: () => void;
}

interface PersistedUiState {
  sidebarCollapsed: boolean;
  schemaCollapsed: boolean;
  editorPct: number;
  resultsMaximized: boolean;
  compactDensity: boolean;
  formatKeywordCase: FormatOptions['keywordCase'];
  formatIndent: FormatOptions['indent'];
  formatLinesBetweenQueries: FormatOptions['linesBetweenQueries'];
}

/** The pre-isolation key held whichever account last used the browser. */
export const LEGACY_UI_STORAGE_KEY = 'mylens.ui.v1';
const USER_UI_STORAGE_PREFIX = 'mylens.ui.v2.';

function userUiStorageKey(userId: string): string {
  return `${USER_UI_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

/*
 * On a first visit below 900px the sidebar starts as a rail (it would eat a
 * quarter of the viewport otherwise). Unlike the old CSS media query that
 * hard-forced the rail, this is only the default: the moment the user toggles,
 * their choice is persisted and honored at every width.
 */
function defaultSidebarCollapsed(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}

function layoutDefaults() {
  return {
    sidebarCollapsed: defaultSidebarCollapsed(),
    schemaCollapsed: false,
    editorPct: 42,
    resultsMaximized: false,
    compactDensity: false,
  };
}

/*
 * Formatter preferences are deliberately outside layoutDefaults:
 * `resetLayout` restores the window layout and must not also silently change
 * how the user formats SQL.
 */
const DEFAULT_FORMAT_STATE = {
  formatKeywordCase: DEFAULT_FORMAT_OPTIONS.keywordCase,
  formatIndent: DEFAULT_FORMAT_OPTIONS.indent,
  formatLinesBetweenQueries: DEFAULT_FORMAT_OPTIONS.linesBetweenQueries,
};

function cleanState(): PersistedUiState {
  return { ...layoutDefaults(), ...DEFAULT_FORMAT_STATE };
}

let activeOwnerId: string | null = null;
let legacyCleanupDone = false;

function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function validKeywordCase(value: unknown): value is FormatOptions['keywordCase'] {
  return value === 'upper' || value === 'lower' || value === 'preserve';
}

function validIndent(value: unknown): value is FormatOptions['indent'] {
  return value === '2' || value === '4' || value === 'tab';
}

function readForUser(userId: string): PersistedUiState {
  const defaults = cleanState();
  try {
    const raw = getStorage()?.getItem(userUiStorageKey(userId));
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedUiState>;
    return {
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean'
          ? parsed.sidebarCollapsed
          : defaults.sidebarCollapsed,
      schemaCollapsed:
        typeof parsed.schemaCollapsed === 'boolean'
          ? parsed.schemaCollapsed
          : defaults.schemaCollapsed,
      editorPct:
        typeof parsed.editorPct === 'number' && Number.isFinite(parsed.editorPct)
          ? Math.max(20, Math.min(78, Math.round(parsed.editorPct)))
          : defaults.editorPct,
      resultsMaximized:
        typeof parsed.resultsMaximized === 'boolean'
          ? parsed.resultsMaximized
          : defaults.resultsMaximized,
      compactDensity:
        typeof parsed.compactDensity === 'boolean'
          ? parsed.compactDensity
          : defaults.compactDensity,
      formatKeywordCase: validKeywordCase(parsed.formatKeywordCase)
        ? parsed.formatKeywordCase
        : defaults.formatKeywordCase,
      formatIndent: validIndent(parsed.formatIndent) ? parsed.formatIndent : defaults.formatIndent,
      formatLinesBetweenQueries:
        parsed.formatLinesBetweenQueries === 1 || parsed.formatLinesBetweenQueries === 2
          ? parsed.formatLinesBetweenQueries
          : defaults.formatLinesBetweenQueries,
    };
  } catch {
    return defaults;
  }
}

function persistedSlice(state: UiState): PersistedUiState {
  return {
    sidebarCollapsed: state.sidebarCollapsed,
    schemaCollapsed: state.schemaCollapsed,
    editorPct: state.editorPct,
    resultsMaximized: state.resultsMaximized,
    compactDensity: state.compactDensity,
    formatKeywordCase: state.formatKeywordCase,
    formatIndent: state.formatIndent,
    formatLinesBetweenQueries: state.formatLinesBetweenQueries,
  };
}

function persistForActiveOwner(state: UiState): void {
  if (!activeOwnerId || state.ownerId !== activeOwnerId) return;
  try {
    getStorage()?.setItem(userUiStorageKey(activeOwnerId), JSON.stringify(persistedSlice(state)));
  } catch {
    // Preferences remain valid for the current visit when storage is blocked.
  }
}

const opening = cleanState();

export const useUiStore = create<UiState>((set, get) => {
  const setAndPersist = (
    update: Partial<UiState> | ((state: UiState) => Partial<UiState>),
  ): void => {
    set(update);
    persistForActiveOwner(get());
  };

  return {
    ...opening,
    ownerId: null,

    hydrateForUser: (userId) => {
      if (!legacyCleanupDone) {
        legacyCleanupDone = true;
        try {
          // Never migrate this value: its owner cannot be proven.
          getStorage()?.removeItem(LEGACY_UI_STORAGE_KEY);
        } catch {
          // Storage unavailable; defaults still isolate the live state.
        }
      }
      // A verified same-user epoch change (for example, a stale cross-tab
      // signal) must not reload persisted layout over newer in-memory choices.
      if (userId !== null && userId === activeOwnerId && get().ownerId === userId) return;
      activeOwnerId = userId;
      set({ ...(userId ? readForUser(userId) : cleanState()), ownerId: userId });
    },

    toggleSidebar: () => setAndPersist((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    setSidebarCollapsed: (value) => setAndPersist({ sidebarCollapsed: value }),
    toggleSchema: () => setAndPersist((state) => ({ schemaCollapsed: !state.schemaCollapsed })),
    setSchemaCollapsed: (value) => setAndPersist({ schemaCollapsed: value }),
    setEditorPct: (value) =>
      setAndPersist({ editorPct: Math.max(20, Math.min(78, Math.round(value))) }),
    toggleResultsMaximized: () =>
      setAndPersist((state) => ({ resultsMaximized: !state.resultsMaximized })),
    setResultsMaximized: (value) => setAndPersist({ resultsMaximized: value }),
    setCompactDensity: (value) => setAndPersist({ compactDensity: value }),
    setFormatOptions: (patch) =>
      setAndPersist((state) => ({
        formatKeywordCase: patch.keywordCase ?? state.formatKeywordCase,
        formatIndent: patch.indent ?? state.formatIndent,
        formatLinesBetweenQueries: patch.linesBetweenQueries ?? state.formatLinesBetweenQueries,
      })),
    resetLayout: () => setAndPersist({ ...layoutDefaults() }),
  };
});
