import { create } from 'zustand';
import type {
  AiReview,
  ExplainResult,
  QueryResult,
  StaticReviewResult,
} from '@shared/types';
import { ApiError } from '@/lib/api';

export type OutputTab = 'results' | 'messages' | 'explain' | 'review';

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  result: QueryResult | null;
  error: ApiError | null;
  explain: ExplainResult | null;
  review: StaticReviewResult | null;
  ai: AiReview | null;
  aiRaw: string;
  aiStreaming: boolean;
  aiError: string | null;
  running: boolean;
  explaining: boolean;
  reviewing: boolean;
  aiRunning: boolean;
  outputTab: OutputTab;
  executedSql: string | null;
}

interface StoredTab {
  id: string;
  title: string;
  sql: string;
}

interface WorkspaceState {
  tabs: QueryTab[];
  activeId: string;
  createTab: (sql?: string) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateSql: (id: string, sql: string) => void;
  patchTab: (id: string, patch: Partial<QueryTab>) => void;
  setOutputTab: (id: string, tab: OutputTab) => void;
}

const STORAGE_KEY = 'mylens.workspace.v1';

const STARTER_SQL = `-- Press Ctrl+Enter to run, Ctrl+Shift+Enter for the selection.
-- Writes are locked until you explicitly unlock them for this connection.
SELECT VERSION() AS server_version, NOW() AS now;
`;

function blankTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: crypto.randomUUID(),
    title: 'Query',
    sql: STARTER_SQL,
    result: null,
    error: null,
    explain: null,
    review: null,
    ai: null,
    aiRaw: '',
    aiStreaming: false,
    aiError: null,
    running: false,
    explaining: false,
    reviewing: false,
    aiRunning: false,
    outputTab: 'results',
    executedSql: null,
    ...overrides,
  };
}

function loadInitial(): { tabs: QueryTab[]; activeId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { tabs?: StoredTab[]; activeId?: string };
      const tabs = (parsed.tabs ?? [])
        .filter((tab) => tab && typeof tab.sql === 'string')
        .slice(0, 30)
        .map((tab) =>
          blankTab({
            id: tab.id || crypto.randomUUID(),
            title: tab.title || 'Query',
            sql: tab.sql,
          }),
        );
      if (tabs.length > 0) {
        const activeId = tabs.some((tab) => tab.id === parsed.activeId)
          ? (parsed.activeId as string)
          : tabs[0].id;
        return { tabs, activeId };
      }
    }
  } catch {
    // Ignore malformed local workspace state.
  }
  const tab = blankTab({ title: 'Query 1' });
  return { tabs: [tab], activeId: tab.id };
}

function save(state: { tabs: QueryTab[]; activeId: string }): void {
  try {
    const tabs: StoredTab[] = state.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      sql: tab.sql,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeId: state.activeId }));
  } catch {
    // Storage can be unavailable in private browsing; the app still works.
  }
}

const initial = loadInitial();

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  tabs: initial.tabs,
  activeId: initial.activeId,

  createTab: (sql) => {
    const tab = blankTab({
      title: `Query ${get().tabs.length + 1}`,
      sql: sql ?? STARTER_SQL,
    });
    const tabs = [...get().tabs, tab];
    set({ tabs, activeId: tab.id });
    save({ tabs, activeId: tab.id });
    return tab.id;
  },

  closeTab: (id) => {
    const existing = get().tabs;
    if (existing.length <= 1) {
      const replacement = blankTab({ title: 'Query 1' });
      set({ tabs: [replacement], activeId: replacement.id });
      save({ tabs: [replacement], activeId: replacement.id });
      return;
    }
    const index = existing.findIndex((tab) => tab.id === id);
    const tabs = existing.filter((tab) => tab.id !== id);
    const activeId =
      get().activeId === id
        ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? tabs[0].id)
        : get().activeId;
    set({ tabs, activeId });
    save({ tabs, activeId });
  },

  setActive: (id) => {
    if (!get().tabs.some((tab) => tab.id === id)) return;
    set({ activeId: id });
    save({ tabs: get().tabs, activeId: id });
  },

  updateSql: (id, sql) => {
    const tabs = get().tabs.map((tab) => (tab.id === id ? { ...tab, sql } : tab));
    set({ tabs });
    save({ tabs, activeId: get().activeId });
  },

  patchTab: (id, patch) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    }));
  },

  setOutputTab: (id, outputTab) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, outputTab } : tab)),
    }));
  },
}));

export function tabById(id: string): QueryTab | undefined {
  return useWorkspaceStore.getState().tabs.find((tab) => tab.id === id);
}

export function isWriteLockedError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'WRITE_LOCKED';
}
