import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config';
import type { HistoryEntry, StatementKind } from '../../shared/types';
import { JsonStore } from './json-store';
import { getSettings } from './settings';

interface HistoryFile {
  entries: HistoryEntry[];
}

const store = new JsonStore<HistoryFile>(path.join(DATA_DIR, 'history.json'), () => ({
  entries: [],
}));

export interface HistoryInput {
  profileId: string;
  database: string | null;
  sql: string;
  kind: StatementKind;
  success: boolean;
  executionMs: number;
  rowCount: number | null;
  error?: string | null;
  userId: string;
}

export async function addHistory(input: HistoryInput): Promise<HistoryEntry> {
  if (!input.userId) {
    throw new Error('History ownership is required.');
  }
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    profileId: input.profileId,
    database: input.database,
    sql: input.sql.slice(0, 100_000),
    kind: input.kind,
    success: input.success,
    executionMs: Math.round(input.executionMs),
    rowCount: input.rowCount,
    error: input.error ? input.error.slice(0, 2_000) : null,
    createdAt: new Date().toISOString(),
    userId: input.userId,
  };
  const settings = await getSettings();
  await store.update((current) => {
    // Retention is a per-owner partition. Keep legacy ownerless entries intact;
    // a modern account's activity can never evict another account or legacy
    // administrator history.
    const mine = [entry, ...current.entries.filter((item) => item.userId === input.userId)].slice(
      0,
      settings.historyLimit,
    );
    const others = current.entries.filter((item) => item.userId !== input.userId);
    return { entries: [...mine, ...others] };
  });
  return entry;
}

export async function listHistory(
  profileId: string | undefined,
  limit: number,
  userId: string,
): Promise<HistoryEntry[]> {
  if (!userId) throw new Error('History ownership is required.');
  const file = await store.read();
  let filtered = profileId
    ? file.entries.filter((entry) => entry.profileId === profileId)
    : file.entries;
  filtered = filtered.filter((entry) => entry.userId === userId);
  return filtered.slice(0, Math.max(1, Math.min(500, limit)));
}

/**
 * Removes only the named owner's entries matching the optional profile.
 * Administrator role does not imply cross-account ownership; account deletion
 * uses the same explicit owner policy with no profile filter.
 */
export async function clearHistory(profileId: string | undefined, userId: string): Promise<void> {
  if (!userId) throw new Error('History ownership is required.');
  await store.update((current) => ({
    entries: current.entries.filter((entry) => {
      const matchesProfile = profileId ? entry.profileId === profileId : true;
      return !(matchesProfile && entry.userId === userId);
    }),
  }));
}

/** Removes every history entry owned by one deleted account. */
export async function deleteHistoryForUser(userId: string): Promise<void> {
  await clearHistory(undefined, userId);
}

export { store as historyStore };
