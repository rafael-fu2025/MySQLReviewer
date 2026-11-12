import crypto from 'node:crypto';
import path from 'node:path';
import type { ActivityAction, ActivityEntry, ActivityPage } from '../../shared/types';
import { DATA_DIR } from '../config';
import { JsonStore } from './json-store';

/**
 * Append-mostly log of who did what, surfaced on the admin page. Per-account
 * partition caps keep installation growth bounded by MAX_USERS while preventing
 * one account from evicting another's evidence.
 */
/** Ordinary high-volume events each account may retain. */
export const MAX_ORDINARY_ENTRIES_PER_USER = 500;
/** Security/admin evidence each account may retain independently. */
export const MAX_RESERVED_ENTRIES_PER_USER = 500;

const ORDINARY_ACTIONS = new Set<ActivityAction>([
  'query',
  'connect',
  'disconnect',
  'practice-generate',
  'practice-evaluate',
  'practice-daily',
]);

function isOrdinary(entry: Pick<ActivityEntry, 'action'>): boolean {
  return ORDINARY_ACTIONS.has(entry.action);
}

/**
 * Retention policy:
 * - ordinary and reserved/security activity each have independent per-account
 *   caps, so no account can evict another account's evidence;
 * - login/logout, unlock/lock, audits, report actions and every admin action use
 *   the reserved partition, which ordinary traffic from the same owner also
 *   cannot evict;
 * - MAX_USERS bounds the installation total while listActivity keeps one
 *   chronological stream for the admin UI.
 */
export function retainActivityEntries(entries: ActivityEntry[]): ActivityEntry[] {
  const ordinaryCount = new Map<string, number>();
  const reservedCount = new Map<string, number>();
  const retainedNewestFirst: ActivityEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const counts = isOrdinary(entry) ? ordinaryCount : reservedCount;
    const limit = isOrdinary(entry) ? MAX_ORDINARY_ENTRIES_PER_USER : MAX_RESERVED_ENTRIES_PER_USER;
    const count = counts.get(entry.userId) ?? 0;
    if (count >= limit) continue;
    counts.set(entry.userId, count + 1);
    retainedNewestFirst.push(entry);
  }
  return retainedNewestFirst.reverse();
}

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
  await store.update((current) => ({
    entries: retainActivityEntries([...current.entries, entry]),
  }));
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

export { store as activityStore };
