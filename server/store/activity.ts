import crypto from 'node:crypto';
import path from 'node:path';
import type { ActivityAction, ActivityEntry, ActivityPage } from '../../shared/types';
import { DATA_DIR } from '../config';
import { JsonStore } from './json-store';

/**
 * Append-mostly log of who did what, surfaced on the admin page. Capped so
 * the file stays small; digests identify queries without storing their text.
 */
const MAX_ENTRIES = 2000;

const store = new JsonStore<{ entries: ActivityEntry[] }>(
  path.join(DATA_DIR, 'activity.json'),
  () => ({ entries: [] }),
);

export interface ActivityInput {
  userId: string;
  username: string;
  action: ActivityAction;
  profileId?: string;
  database?: string;
  digest?: string;
  detail?: string;
}

export async function logActivity(input: ActivityInput): Promise<void> {
  const entry: ActivityEntry = {
    id: crypto.randomBytes(9).toString('base64url'),
    at: new Date().toISOString(),
    userId: input.userId,
    username: input.username,
    action: input.action,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.database ? { database: input.database } : {}),
    ...(input.digest ? { digest: input.digest } : {}),
    ...(input.detail ? { detail: input.detail.slice(0, 200) } : {}),
  };
  await store.update((current) => {
    const next = [...current.entries, entry];
    return { entries: next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next };
  });
}

export async function listActivity(options: {
  userId?: string;
  limit?: number;
  offset?: number;
}): Promise<ActivityPage> {
  const entries = (await store.read()).entries;
  const filtered = options.userId
    ? entries.filter((entry) => entry.userId === options.userId)
    : entries;
  const newestFirst = [...filtered].reverse();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  return { entries: newestFirst.slice(offset, offset + limit), total: filtered.length };
}
