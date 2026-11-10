import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_FORMAT_OPTIONS, type FormatOptions } from '@/lib/sql-snippets';

interface UiState {
  sidebarCollapsed: boolean;
  schemaCollapsed: boolean;
  editorPct: number;
  resultsMaximized: boolean;
  compactDensity: boolean;
  /** SQL formatter preferences, persisted like the layout settings. */
  formatKeywordCase: FormatOptions['keywordCase'];
  formatIndent: FormatOptions['indent'];
  formatLinesBetweenQueries: FormatOptions['linesBetweenQueries'];
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

/*
 * On a first visit below 900px the sidebar starts as a rail (it would eat a
 * quarter of the viewport otherwise). Unlike the old CSS media query that
 * hard-forced the rail, this is only the default: the moment the user
 * toggles, their choice is persisted and honored at every width.
 */
function defaultSidebarCollapsed(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}

const DEFAULTS = {
  sidebarCollapsed: defaultSidebarCollapsed(),
  schemaCollapsed: false,
  editorPct: 42,
  resultsMaximized: false,
  compactDensity: false,
};

/*
 * Formatter preferences are deliberately outside DEFAULTS: `resetLayout`
 * restores the window layout and must not also silently change how the user
 * formats their SQL.
 */
const DEFAULT_FORMAT_STATE = {
  formatKeywordCase: DEFAULT_FORMAT_OPTIONS.keywordCase,
  formatIndent: DEFAULT_FORMAT_OPTIONS.indent,
  formatLinesBetweenQueries: DEFAULT_FORMAT_OPTIONS.linesBetweenQueries,
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      ...DEFAULT_FORMAT_STATE,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (value) => set({ sidebarCollapsed: value }),
      toggleSchema: () => set((state) => ({ schemaCollapsed: !state.schemaCollapsed })),
      setSchemaCollapsed: (value) => set({ schemaCollapsed: value }),
      setEditorPct: (value) => set({ editorPct: Math.max(20, Math.min(78, Math.round(value))) }),
      toggleResultsMaximized: () => set((state) => ({ resultsMaximized: !state.resultsMaximized })),
      setResultsMaximized: (value) => set({ resultsMaximized: value }),
      setCompactDensity: (value) => set({ compactDensity: value }),
      setFormatOptions: (patch) =>
        set((state) => ({
          formatKeywordCase: patch.keywordCase ?? state.formatKeywordCase,
          formatIndent: patch.indent ?? state.formatIndent,
          formatLinesBetweenQueries: patch.linesBetweenQueries ?? state.formatLinesBetweenQueries,
        })),
      resetLayout: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'mylens.ui.v1',
      version: 1,
    },
  ),
);
