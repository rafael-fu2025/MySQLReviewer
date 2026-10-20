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
  };
  const settings = await getSettings();
  await store.update((current) => ({
    entries: [entry, ...current.entries].slice(0, settings.historyLimit),
  }));
  return entry;
}

export async function listHistory(profileId?: string, limit = 100): Promise<HistoryEntry[]> {
  const file = await store.read();
  const filtered = profileId
    ? file.entries.filter((entry) => entry.profileId === profileId)
    : file.entries;
  return filtered.slice(0, Math.max(1, Math.min(500, limit)));
}

export async function clearHistory(profileId?: string): Promise<void> {
  if (!profileId) {
    await store.write({ entries: [] });
    return;
  }
  await store.update((current) => ({
    entries: current.entries.filter((entry) => entry.profileId !== profileId),
  }));
}
