import { create } from 'zustand';
import type {
  AiChatMessage,
  AiReview,
  ExplainResult,
  QueryResult,
  StaticReviewResult,
} from '@shared/types';
import { api, getApiToken, type ApiError } from '@/lib/api';
import { randomId } from '@/lib/uuid';

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
  /**
   * The assistant conversation for this tab. Each tab keeps its own, so
   * moving to another tab and back does not lose the thread.
   */
  assistantTurns: AiChatMessage[];
  /** The follow-up conversation under the review, kept per tab as well. */
  reviewChatTurns: AiChatMessage[];
  running: boolean;
  explaining: boolean;
  reviewing: boolean;
  aiRunning: boolean;
  outputTab: OutputTab;
  executedSql: string | null;
}

/** The persisted per-tab shape: what the server stores, nothing more. */
interface StoredTab {
  id: string;
  title: string;
  sql: string;
}

/** The workspace document the server keeps per account. */
interface WorkspacePayload {
  tabs: StoredTab[];
  activeId: string;
}

/** The GET response after the api client unwraps `{ data }`. */
interface ServerWorkspace {
  tabs: Array<{ id?: string; title?: string; sql?: string }>;
  activeId: string;
}

interface WorkspaceState {
  tabs: QueryTab[];
  activeId: string;
  /** The signed-in user these tabs belong to; null when signed out. */
  ownerId: string | null;
  /**
   * Swap the in-memory workspace to the given account's server-persisted
   * tabs. Called by app-store when the session resolves or ends. Signing out
   * clears memory — tabs and AI threads must not leak into the next account
   * on this browser — while the owner's saved blob stays on the server for
   * their next sign-in, on this PC or any other.
   */
  hydrateForUser: (userId: string | null) => void;
  createTab: (sql?: string) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateSql: (id: string, sql: string) => void;
  patchTab: (id: string, patch: Partial<QueryTab>) => void;
  setOutputTab: (id: string, tab: OutputTab) => void;
}

const LEGACY_STORAGE_KEY = 'mylens.workspace.v1';
const SAVE_DELAY_MS = 400;
const MAX_TABS = 30;

/**
 * Workspace persistence lives on the server, scoped per signed-in user: tabs,
 * their SQL and their per-tab AI threads belong to an account, not to a
 * browser, so the workspace follows the account across devices. The owner is
 * set by the session (app-store) on bootstrap, sign-in and sign-out.
 */

/** The signed-in user whose tabs are in memory and on the server; null when out. */
let ownerUserId: string | null = null;
let pendingSave: { tabs: QueryTab[]; activeId: string } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** One failed GET is reported once per session, not once per retry. */
let warnedLoadFailure = false;
/** The leaked pre-multiuser localStorage blob is deleted on the first hydrate. */
let legacyCleanupDone = false;

const STARTER_SQL = `-- Press Ctrl+Enter to run, Ctrl+Shift+Enter for the selection.
-- Writes are locked until you explicitly unlock them for this connection.
SELECT VERSION() AS server_version, NOW() AS now;
`;

function blankTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: randomId(),
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
    assistantTurns: [],
    reviewChatTurns: [],
    running: false,
    explaining: false,
    reviewing: false,
    aiRunning: false,
    outputTab: 'results',
    executedSql: null,
    ...overrides,
  };
}

/**
 * Maps the server blob onto live tabs exactly like the old localStorage
 * loader: well-formed tabs are rebuilt through blankTab (every derived field
 * starts fresh), over-long lists are capped, and the active id must name a
 * kept tab. Null when the server has no workspace for this account yet.
 */
function rebuildFromServer(data: ServerWorkspace): { tabs: QueryTab[]; activeId: string } | null {
  const tabs = data.tabs
    .filter(
      (tab): tab is { id?: string; title?: string; sql: string } =>
        typeof tab === 'object' && tab !== null && typeof tab.sql === 'string',
    )
    .slice(0, MAX_TABS)
    .map((tab) =>
      blankTab({
        id: tab.id || randomId(),
        title: tab.title || 'Query',
        sql: tab.sql,
      }),
    );
  if (tabs.length === 0) return null;
  const activeId = tabs.some((tab) => tab.id === data.activeId) ? data.activeId : tabs[0].id;
  return { tabs, activeId };
}

/** The wire shape: only what the server stores, exactly what flush serialized. */
function toPayload(state: { tabs: QueryTab[]; activeId: string }): WorkspacePayload {
  return {
    tabs: state.tabs.map((tab) => ({ id: tab.id, title: tab.title, sql: tab.sql })),
    activeId: state.activeId,
  };
}

/** Takes the pending snapshot now, clearing the debounce; null when idle. */
function takePending(): { tabs: QueryTab[]; activeId: string } | null {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const state = pendingSave;
  pendingSave = null;
  return state;
}

/**
 * Immediate PUT of the pending snapshot. Awaitable for callers that need the
 * round trip; owner switches call it fire-and-forget (`void flush()`) since
 * hydrateForUser must stay synchronous. A failed PUT keeps the in-memory
 * state as the source of truth — the next save retries with fresh state.
 */
async function flush(): Promise<void> {
  const state = takePending();
  // Signed out: there is no owner to write under.
  if (!state || !ownerUserId) return;
  try {
    await api.put('/api/workspace', toPayload(state));
  } catch {
    // No toast spam: the in-memory workspace keeps working, and the next
    // save retries with fresh state.
  }
}

/**
 * The unload-path flush: pagehide/visibilitychange/beforeunload cannot rely
 * on the page living long enough for the api client's request, so this PUT
 * goes out through a raw fetch with `keepalive: true` — api.ts has no
 * keepalive option, so its headers are mirrored here (its token accessor is
 * reused rather than replicated).
 */
function flushKeepalive(): void {
  const state = takePending();
  if (!state || !ownerUserId) return;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const token = getApiToken();
  if (token) headers['x-mylens-token'] = token;
  void fetch('/api/workspace', {
    method: 'PUT',
    keepalive: true,
    headers,
    body: JSON.stringify(toPayload(state)),
  }).catch(() => {
    // Nothing can be done at unload; the next save re-syncs.
  });
}

/** Debounced write: editing must not PUT on every keystroke. */
function save(state: { tabs: QueryTab[]; activeId: string }): void {
  // Signed out: no server calls — nowhere to persist, nothing to queue.
  if (!ownerUserId) return;
  pendingSave = state;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), SAVE_DELAY_MS);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushKeepalive);
  window.addEventListener('pagehide', flushKeepalive);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushKeepalive();
  });
}

// The opening workspace is a single blank tab. Real per-user state arrives
// when the session resolves (hydrateForUser, called by app-store) — loading
// before the user is known would share one browser's workspace across every
// account that signs into it.
const openingTab = blankTab({ title: 'Query 1' });

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  /**
   * Loads the signed-in owner's saved workspace from the server and swaps it
   * into memory. A stale response — the owner moved on before it arrived —
   * is dropped, so it can never overwrite another account's tabs.
   */
  async function loadWorkspace(userId: string): Promise<void> {
    try {
      const data = await api.get<ServerWorkspace>('/api/workspace');
      if (ownerUserId !== userId) return;
      const loaded = rebuildFromServer(data);
      if (loaded) {
        set({ tabs: loaded.tabs, activeId: loaded.activeId, ownerId: userId });
        return;
      }
      // The account has no workspace on the server yet: keep the blank tab —
      // its id is the identity every per-tab feature hangs off — and queue a
      // save so that id exists server-side before the first edit.
      save({ tabs: get().tabs, activeId: get().activeId });
    } catch {
      // Keep the blank workspace and stay usable; warn once, not per retry.
      if (!warnedLoadFailure) {
        warnedLoadFailure = true;
        console.warn('[mylens] Could not load the saved workspace; starting blank.');
      }
    }
  }

  return {
    tabs: [openingTab],
    activeId: openingTab.id,
    ownerId: null,

    hydrateForUser: (userId) => {
      if (userId === ownerUserId) return;
      // A pending edit belongs to the outgoing owner: put it on the wire
      // before the owner changes. Fire-and-forget — this must stay
      // synchronous (app-store calls it without awaiting).
      void flush();
      ownerUserId = userId;
      // One-time cleanup: the pre-multiuser build persisted every account's
      // tabs under one global key — drop it rather than adopt it, so one
      // account's workspace can never surface under another.
      if (!legacyCleanupDone) {
        legacyCleanupDone = true;
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          // Storage unavailable; nothing to clean up.
        }
      }
      // Blank the in-memory workspace for whoever holds the session now —
      // including a signed-in owner: their saved tabs arrive with the server
      // response below, and the previous account's tabs must never flash
      // meanwhile.
      const tab = blankTab({ title: 'Query 1' });
      set({ tabs: [tab], activeId: tab.id, ownerId: userId });
      if (userId === null) return;
      // Dispatched on a microtask so the outgoing owner's flush has been put
      // on the wire before the load request leaves.
      queueMicrotask(() => void loadWorkspace(userId));
    },

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
      const tabs = get().tabs.map((tab) => {
        if (tab.id !== id) return tab;
        // Nothing changed: keep the derived state (and object identity) intact.
        if (tab.sql === sql) return tab;
        return {
          ...tab,
          sql,
          // Everything below describes the *previous* text, so it is stale now.
          result: null,
          error: null,
          explain: null,
          review: null,
          ai: null,
          aiRaw: '',
          aiStreaming: false,
          aiError: null,
          executedSql: null,
        };
      });
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
  };
});
