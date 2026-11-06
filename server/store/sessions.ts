import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { JsonStore } from './json-store';

/**
 * Signed-in sessions, persisted so sharing the app survives server restarts.
 * The id lives in an httpOnly cookie; 30-day sliding expiry.
 */
export interface StoredSession {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
export const SESSION_COOKIE = 'mylens_session';

const store = new JsonStore<{ sessions: StoredSession[] }>(
  path.join(DATA_DIR, 'sessions.json'),
  () => ({ sessions: [] }),
);

export function parseSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export async function createSession(userId: string): Promise<StoredSession> {
  const now = new Date();
  const session: StoredSession = {
    id: crypto.randomBytes(32).toString('base64url'),
    userId,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  };
  await store.update((current) => {
    // Drop expired sessions first so the cap never evicts live ones.
    const live = current.sessions.filter((s) => new Date(s.expiresAt).getTime() > Date.now());
    const trimmed = live.length >= MAX_SESSIONS ? live.slice(live.length - MAX_SESSIONS + 1) : live;
    return { sessions: [...trimmed, session] };
  });
  return session;
}

/** Resolves a session id, sliding its expiry; returns null when expired. */
export async function resolveSession(id: string | null): Promise<StoredSession | null> {
  if (!id) return null;
  const sessions = (await store.read()).sessions;
  const session = sessions.find((entry) => entry.id === id);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const lastSeenAt = new Date().toISOString();
  if (new Date(session.lastSeenAt).getTime() < Date.now() - 60 * 60 * 1000) {
    // Slide at most once an hour to keep writes rare.
    await store.update((current) => ({
      sessions: current.sessions.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              lastSeenAt,
              expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
            }
          : entry,
      ),
    }));
  }
  return session;
}

export async function deleteSession(id: string | null): Promise<void> {
  if (!id) return;
  await store.update((current) => ({
    sessions: current.sessions.filter((entry) => entry.id !== id),
  }));
}

export async function deleteSessionsForUser(userId: string): Promise<void> {
  await store.update((current) => ({
    sessions: current.sessions.filter((entry) => entry.userId !== userId),
  }));
}

export function sessionCookieHeader(session: StoredSession): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
