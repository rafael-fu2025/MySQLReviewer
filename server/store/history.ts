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
  userId?: string;
}

export async function addHistory(input: HistoryInput): Promise<HistoryEntry> {
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
    ...(input.userId ? { userId: input.userId } : {}),
  };
  const settings = await getSettings();
  await store.update((current) => ({
    entries: [entry, ...current.entries].slice(0, settings.historyLimit),
  }));
  return entry;
}

export async function listHistory(
  profileId?: string,
  limit = 100,
  userId?: string,
): Promise<HistoryEntry[]> {
  const file = await store.read();
  let filtered = profileId
    ? file.entries.filter((entry) => entry.profileId === profileId)
    : file.entries;
  // Members see only their own statements. Pre-admin entries (no userId)
  // belong to the admin and stay invisible to members.
  if (userId) {
    filtered = filtered.filter((entry) => entry.userId === userId);
  }
  return filtered.slice(0, Math.max(1, Math.min(500, limit)));
}

/**
 * Removes entries matching the given constraints. A member passes their own
 * userId, so clearing "their" history never touches anyone else's entries on
 * a shared connection; an admin passing only profileId clears all of it.
 */
export async function clearHistory(profileId?: string, userId?: string): Promise<void> {
  if (!profileId && !userId) {
    await store.write({ entries: [] });
    return;
  }
  await store.update((current) => ({
    entries: current.entries.filter((entry) => {
      const matchesProfile = profileId ? entry.profileId === profileId : true;
      const matchesUser = userId ? entry.userId === userId : true;
      return !(matchesProfile && matchesUser);
    }),
  }));
}
