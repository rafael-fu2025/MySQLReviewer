import path from 'node:path';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import { JsonStore } from './json-store';

/**
 * The query workspace — the statement tabs (id, title, sql) and the active
 * one — persisted per signed-in account so it follows the account across
 * devices: signing in from any PC on the LAN restores that user's own tabs,
 * never another account's.
 *
 * The client owns the tab ids and titles; the server is a per-user document
 * with strict caps so one runaway editor cannot bloat the shared store. Growth
 * of the outer map is bounded by the account count, so it needs no global cap.
 */

export interface StoredWorkspaceTab {
  id: string;
  title: string;
  sql: string;
}

export interface StoredWorkspace {
  tabs: StoredWorkspaceTab[];
  activeId: string;
}

/** Keyed by user id. */
type WorkspaceFile = Record<string, StoredWorkspace>;

const store = new JsonStore<WorkspaceFile>(path.join(DATA_DIR, 'workspace.json'), () => ({}));

const MAX_TABS = 30;
const MAX_TITLE_CHARS = 500;
const MAX_SQL_CHARS = 200_000;
/** Same ceiling as conversation ids; the client generates UUID-shaped ids. */
const MAX_ID_CHARS = 120;

export interface WorkspaceInput {
  tabs: StoredWorkspaceTab[];
  activeId: string;
}

/**
 * Keeps only well-formed tabs (a non-empty string id, a string sql), clamps
 * the field lengths and caps the count; tabs failing validation are dropped
 * rather than rejected, mirroring how the client sanitized its own blob back
 * when the workspace lived in localStorage.
 */
function sanitizeTabs(input: unknown): StoredWorkspaceTab[] {
  const raw = Array.isArray(input) ? input : [];
  const tabs: StoredWorkspaceTab[] = [];
  for (const entry of raw) {
    const candidate = entry as Partial<StoredWorkspaceTab> | null;
    if (!candidate || typeof candidate.id !== 'string' || typeof candidate.sql !== 'string') {
      continue;
    }
    const id = candidate.id.trim();
    if (!id) continue;
    const title = typeof candidate.title === 'string' ? candidate.title : '';
    tabs.push({
      id: id.slice(0, MAX_ID_CHARS),
      title: title.slice(0, MAX_TITLE_CHARS),
      sql: candidate.sql.slice(0, MAX_SQL_CHARS),
    });
    if (tabs.length >= MAX_TABS) break;
  }
  return tabs;
}

/**
 * The signed-in user's persisted workspace. Blank (no tabs yet) when they
 * have none: the client keeps its opening blank tab and saves it, so the tab
 * id exists server-side before the first edit.
 */
export async function getWorkspace(userId: string): Promise<StoredWorkspace> {
  if (!userId) return { tabs: [], activeId: '' };
  const file = await store.read();
  const entry = file[userId];
  if (!entry || !Array.isArray(entry.tabs)) return { tabs: [], activeId: '' };
  return entry;
}

/**
 * Validates, clamps and stores the workspace for one account. The active id
 * must name a kept tab; anything else falls back to the first tab (or none
 * for an empty workspace).
 */
export async function saveWorkspace(userId: string, input: WorkspaceInput): Promise<void> {
  if (!userId) {
    throw new AppError('AUTH_REQUIRED', 'Sign in to save the workspace.', 401);
  }
  const tabs = sanitizeTabs(input?.tabs);
  const requestedActiveId = typeof input?.activeId === 'string' ? input.activeId : '';
  const activeId = tabs.some((tab) => tab.id === requestedActiveId)
    ? requestedActiveId
    : (tabs[0]?.id ?? '');
  await store.update((current) => ({ ...current, [userId]: { tabs, activeId } }));
}

/** Removes one account's workspace (for symmetry with the account lifecycle). */
export async function deleteWorkspace(userId: string): Promise<void> {
  if (!userId) {
    throw new AppError('AUTH_REQUIRED', 'Sign in first.', 401);
  }
  await store.update((current) => {
    if (!current[userId]) return current;
    const next = { ...current };
    delete next[userId];
    return next;
  });
}

export { store as workspaceStore };
