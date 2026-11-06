import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  schemaCollapsed: boolean;
  editorPct: number;
  resultsMaximized: boolean;
  compactDensity: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (value: boolean) => void;
  toggleSchema: () => void;
  setSchemaCollapsed: (value: boolean) => void;
  setEditorPct: (value: number) => void;
  toggleResultsMaximized: () => void;
  setResultsMaximized: (value: boolean) => void;
  setCompactDensity: (value: boolean) => void;
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

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (value) => set({ sidebarCollapsed: value }),
      toggleSchema: () => set((state) => ({ schemaCollapsed: !state.schemaCollapsed })),
      setSchemaCollapsed: (value) => set({ schemaCollapsed: value }),
      setEditorPct: (value) => set({ editorPct: Math.max(20, Math.min(78, Math.round(value))) }),
      toggleResultsMaximized: () => set((state) => ({ resultsMaximized: !state.resultsMaximized })),
      setResultsMaximized: (value) => set({ resultsMaximized: value }),
      setCompactDensity: (value) => set({ compactDensity: value }),
      resetLayout: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'mylens.ui.v1',
      version: 1,
    },
  ),
);
