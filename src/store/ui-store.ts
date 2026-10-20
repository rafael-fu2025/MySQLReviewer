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

const DEFAULTS = {
  sidebarCollapsed: false,
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
      setEditorPct: (value) =>
        set({ editorPct: Math.max(20, Math.min(78, Math.round(value))) }),
      toggleResultsMaximized: () =>
        set((state) => ({ resultsMaximized: !state.resultsMaximized })),
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
