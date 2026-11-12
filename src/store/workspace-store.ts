import { create } from 'zustand';
import type {
  AiChatMessage,
  AiReview,
  ExplainResult,
  QueryResult,
  StaticReviewResult,
} from '@shared/types';
import {
  api,
  apiSessionHeaders,
  assertApiSessionCurrent,
  getApiSessionSnapshot,
  isApiSessionCurrent,
  type ApiError,
  type ApiSessionSnapshot,
} from '@/lib/api';
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
  /** The assistant conversation for this tab. */
  assistantTurns: AiChatMessage[];
  /** The follow-up conversation under the review. */
  reviewChatTurns: AiChatMessage[];
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

interface WorkspacePayload {
  tabs: StoredTab[];
  activeId: string;
}

interface ServerWorkspace {
  tabs: Array<{ id?: string; title?: string; sql?: string }>;
  activeId: string;
}

interface WorkspaceSnapshot {
  tabs: QueryTab[];
  activeId: string;
}

interface PendingSave {
  ownerId: string;
  epoch: number;
  snapshot: WorkspaceSnapshot;
  revision: number;
}

interface WorkspaceState {
  tabs: QueryTab[];
  activeId: string;
  /** The signed-in user these tabs belong to; null when signed out/frozen. */
  ownerId: string | null;
  /** Account epoch that owns the current tabs. */
  ownerEpoch: number | null;
  /** True while the owner's server blob is being loaded. */
  loading: boolean;
  /** Switch to a verified account or synchronously clear for a transition. */
  hydrateForUser: (userId: string | null, session?: ApiSessionSnapshot) => void;
  /** Durably save one owner's queued work before logout clears its cookie. */
  flushForUser: (userId: string, session?: ApiSessionSnapshot) => Promise<void>;
  createTab: (sql?: string) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateSql: (id: string, sql: string) => void;
  patchTab: (id: string, patch: Partial<QueryTab>) => void;
  setOutputTab: (id: string, tab: OutputTab) => void;
}

const LEGACY_STORAGE_KEY = 'mylens.workspace.v1';
const SAVE_DELAY_MS = 400;
const RETRY_DELAY_MS = 1_200;
const MAX_TABS = 30;

let ownerUserId: string | null = null;
let ownerEpoch: number | null = null;
let pendingSave: PendingSave | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let activeFlush: { session: ApiSessionSnapshot; promise: Promise<void> } | null = null;
let saveRevision = 0;
let hydrateGeneration = 0;
let warnedLoadFailure = false;
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

function blankWorkspace(): WorkspaceSnapshot {
  const tab = blankTab({ title: 'Query 1' });
  return { tabs: [tab], activeId: tab.id };
}

function rebuildFromServer(data: ServerWorkspace): WorkspaceSnapshot | null {
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

function toPayload(state: WorkspaceSnapshot): WorkspacePayload {
  return {
    tabs: state.tabs.map((tab) => ({ id: tab.id, title: tab.title, sql: tab.sql })),
    activeId: state.activeId,
  };
}

function clearSaveTimer(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
}

function pendingBelongsTo(pending: PendingSave, session: ApiSessionSnapshot): boolean {
  return pending.ownerId === session.userId && pending.epoch === session.epoch;
}

function currentOwnerSession(): ApiSessionSnapshot | null {
  if (!ownerUserId || ownerEpoch === null) return null;
  return { userId: ownerUserId, epoch: ownerEpoch };
}

function scheduleFlush(delay = SAVE_DELAY_MS): void {
  clearSaveTimer();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushPending().catch(() => undefined);
  }, delay);
}

/**
 * Flushes the exact owner+epoch tagged snapshot. Failed writes stay queued for
 * retry; a newer edit wins over an older failed request and is never erased by
 * its completion.
 */
async function flushPending(explicitSession?: ApiSessionSnapshot): Promise<void> {
  clearSaveTimer();
  const session = explicitSession ?? currentOwnerSession();
  if (!session) return;
  if (
    activeFlush &&
    activeFlush.session.epoch === session.epoch &&
    activeFlush.session.userId === session.userId
  ) {
    await activeFlush.promise;
  }

  const pending = pendingSave;
  if (!pending || !pendingBelongsTo(pending, session)) return;
  assertApiSessionCurrent(session);

  const run = (async () => {
    try {
      await api.put('/api/workspace', toPayload(pending.snapshot), { session });
      // Clear only what was actually sent. An edit made during the PUT has a
      // greater revision and remains queued for a second round below. A same-user
      // session revalidation may also retag this revision to a newer epoch while
      // the old request is unwinding; that preserved revision must not be erased.
      if (pendingSave?.revision === pending.revision && pendingBelongsTo(pendingSave, session)) {
        pendingSave = null;
      }
    } catch (error) {
      if (pendingSave?.revision === pending.revision && isApiSessionCurrent(session)) {
        scheduleFlush(RETRY_DELAY_MS);
      }
      throw error;
    }
  })();
  activeFlush = { session, promise: run };
  try {
    await run;
  } finally {
    if (activeFlush?.promise === run) activeFlush = null;
  }

  // Logout needs every edit through the point of sign-out, including one made
  // while a debounce PUT was already in flight. Drain that newer revision too.
  if (explicitSession && pendingSave && pendingBelongsTo(pendingSave, session)) {
    await flushPending(session);
  }
}

/** The unload path cannot await, but it still asserts both owner and epoch. */
function flushKeepalive(): void {
  clearSaveTimer();
  const pending = pendingSave;
  const session = currentOwnerSession();
  if (!pending || !session || !pendingBelongsTo(pending, session)) return;
  if (!isApiSessionCurrent(session)) return;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...apiSessionHeaders(session, { expectedUserId: pending.ownerId }),
  };
  void fetch('/api/workspace', {
    method: 'PUT',
    keepalive: true,
    headers,
    body: JSON.stringify(toPayload(pending.snapshot)),
  }).catch(() => {
    // The pending snapshot intentionally remains queued for the next live save.
  });
}

function save(state: WorkspaceSnapshot): void {
  const session = currentOwnerSession();
  if (!session || !isApiSessionCurrent(session)) return;
  saveRevision += 1;
  pendingSave = {
    ownerId: session.userId as string,
    epoch: session.epoch,
    snapshot: state,
    revision: saveRevision,
  };
  scheduleFlush();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushKeepalive);
  window.addEventListener('pagehide', flushKeepalive);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushKeepalive();
  });
}

const opening = blankWorkspace();

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  async function loadWorkspace(
    userId: string,
    session: ApiSessionSnapshot,
    generation: number,
  ): Promise<void> {
    try {
      const data = await api.get<ServerWorkspace>('/api/workspace', { session });
      if (
        generation !== hydrateGeneration ||
        ownerUserId !== userId ||
        ownerEpoch !== session.epoch ||
        !isApiSessionCurrent(session)
      ) {
        return;
      }
      const loaded = rebuildFromServer(data);
      if (loaded) {
        set({
          tabs: loaded.tabs,
          activeId: loaded.activeId,
          ownerId: userId,
          ownerEpoch: session.epoch,
          loading: false,
        });
        return;
      }
      set({ loading: false });
      save({ tabs: get().tabs, activeId: get().activeId });
    } catch {
      if (
        generation !== hydrateGeneration ||
        ownerUserId !== userId ||
        ownerEpoch !== session.epoch ||
        !isApiSessionCurrent(session)
      ) {
        return;
      }
      set({ loading: false });
      if (!warnedLoadFailure) {
        warnedLoadFailure = true;
        console.warn('[mylens] Could not load the saved workspace; starting blank.');
      }
    }
  }

  return {
    tabs: opening.tabs,
    activeId: opening.activeId,
    ownerId: null,
    ownerEpoch: null,
    loading: false,

    hydrateForUser: (userId, suppliedSession) => {
      const session = suppliedSession ?? getApiSessionSnapshot();
      const sameOwner = userId !== null && userId === ownerUserId;
      if (sameOwner && session.epoch === ownerEpoch && isApiSessionCurrent(session)) return;
      if (sameOwner) {
        // Identity verification can advance the transport epoch even when the
        // cookie still belongs to A (a stale cross-tab signal, failed login, or
        // logout mismatch). Keep A's exact live workspace and pending revision;
        // only retag them so future saves assert the newly verified epoch.
        hydrateGeneration += 1;
        clearSaveTimer();
        activeFlush = null;
        ownerEpoch = session.epoch;
        if (pendingSave) {
          pendingSave = { ...pendingSave, epoch: session.epoch };
          scheduleFlush();
        }
        set({ ownerId: userId, ownerEpoch: session.epoch, loading: false });
        return;
      }

      hydrateGeneration += 1;
      clearSaveTimer();
      // A pending snapshot is meaningful only to its owner. A verified account
      // switch clears it; same-owner epoch changes are handled above.
      pendingSave = null;
      activeFlush = null;
      ownerUserId = userId;
      ownerEpoch = userId ? session.epoch : null;

      if (!legacyCleanupDone) {
        legacyCleanupDone = true;
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          // Storage unavailable; nothing to clean up.
        }
      }

      const blank = blankWorkspace();
      set({
        tabs: blank.tabs,
        activeId: blank.activeId,
        ownerId: userId,
        ownerEpoch: userId ? session.epoch : null,
        loading: userId !== null,
      });
      if (!userId) return;
      const generation = hydrateGeneration;
      queueMicrotask(() => void loadWorkspace(userId, session, generation));
    },

    flushForUser: async (userId, suppliedSession) => {
      const session = suppliedSession ?? getApiSessionSnapshot();
      if (session.userId !== userId || ownerUserId !== userId || ownerEpoch !== session.epoch) {
        throw new Error('The workspace no longer belongs to this account session.');
      }
      await flushPending(session);
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
        if (tab.sql === sql) return tab;
        return {
          ...tab,
          sql,
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
      // Account-derived/transient results are intentionally not persisted.
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
