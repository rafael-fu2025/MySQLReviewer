import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import type { ConnectionInput, ConnectionProfile, SslConfig } from '../../shared/types';
import { decryptSecret, encryptSecret } from './crypto';
import { JsonStore } from './json-store';

interface StoredProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database?: string | null;
  socketPath?: string | null;
  ssl?: SslConfig | null;
  rememberPassword: boolean;
  passwordEnc?: string | null;
  color?: string | null;
  databaseScope?: 'all' | 'selected';
  allowedDatabases?: string[];
  allowServerWideInsights?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

interface ProfileFile {
  profiles: StoredProfile[];
}

const XAMPP_SEED: StoredProfile = {
  id: 'xampp-local',
  name: 'XAMPP (local MariaDB)',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  database: null,
  socketPath: null,
  ssl: null,
  rememberPassword: true,
  passwordEnc: null,
  color: '#ff8a3d',
  databaseScope: 'all',
  allowedDatabases: [],
  allowServerWideInsights: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastUsedAt: null,
};

const store = new JsonStore<ProfileFile>(path.join(DATA_DIR, 'profiles.json'), () => ({
  profiles: [{ ...XAMPP_SEED }],
}));

/** Passwords explicitly not saved to disk live only for this server process. */
const sessionPasswords = new Map<string, string>();

function now(): string {
  return new Date().toISOString();
}

function cleanSsl(ssl: SslConfig | undefined): SslConfig | null {
  if (!ssl || !ssl.enabled) return null;
  return {
    enabled: true,
    rejectUnauthorized: ssl.rejectUnauthorized !== false,
    ca: ssl.ca?.trim() || undefined,
    cert: ssl.cert?.trim() || undefined,
    key: ssl.key?.trim() || undefined,
  };
}

function validate(input: ConnectionInput): ConnectionInput {
  const name = input.name?.trim();
  const host = input.host?.trim() || '127.0.0.1';
  const user = input.user?.trim();
  const port = Number(input.port);
  if (!name) throw new AppError('VALIDATION', 'Give this connection a name.');
  if (!user) throw new AppError('VALIDATION', 'MySQL user is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError('VALIDATION', 'Port must be an integer between 1 and 65535.');
  }
  const databaseScope = input.databaseScope === 'selected' ? 'selected' : 'all';
  const allowedDatabases = Array.from(
    new Set(
      (input.allowedDatabases ?? [])
        .map((database) => database.trim())
        .filter(Boolean),
    ),
  ).slice(0, 200);
  if (databaseScope === 'selected' && allowedDatabases.length === 0) {
    throw new AppError(
      'VALIDATION',
      'Select at least one database for a scoped connection, or use "All databases".',
    );
  }
  const database = input.database?.trim() || undefined;
  if (
    databaseScope === 'selected' &&
    database &&
    !allowedDatabases.includes(database)
  ) {
    throw new AppError(
      'VALIDATION',
      'The default database must be one of the selected databases.',
    );
  }
  return {
    ...input,
    name: name.slice(0, 120),
    host,
    port,
    user: user.slice(0, 128),
    database,
    socketPath: input.socketPath?.trim() || undefined,
    rememberPassword: input.rememberPassword !== false,
    databaseScope,
    allowedDatabases,
    allowServerWideInsights: input.allowServerWideInsights !== false,
  };
}

function toPublic(profile: StoredProfile): ConnectionProfile {
  const saved = Boolean(profile.passwordEnc);
  const session = sessionPasswords.has(profile.id);
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    database: profile.database ?? null,
    socketPath: profile.socketPath ?? null,
    ssl: profile.ssl ?? null,
    rememberPassword: profile.rememberPassword,
    hasPassword: saved || session,
    passwordSource: saved ? 'saved' : session ? 'session' : 'none',
    color: profile.color ?? null,
    databaseScope: profile.databaseScope === 'selected' ? 'selected' : 'all',
    allowedDatabases: profile.allowedDatabases ?? [],
    allowServerWideInsights: profile.allowServerWideInsights !== false,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastUsedAt: profile.lastUsedAt ?? null,
  };
}

export async function listProfiles(): Promise<ConnectionProfile[]> {
  const file = await store.read();
  return file.profiles.map(toPublic);
}

export async function getStoredProfile(id: string): Promise<StoredProfile> {
  const file = await store.read();
  const profile = file.profiles.find((item) => item.id === id);
  if (!profile) throw new AppError('PROFILE_NOT_FOUND', 'Connection profile not found.', 404);
  return profile;
}

export async function getProfile(id: string): Promise<ConnectionProfile> {
  return toPublic(await getStoredProfile(id));
}

export async function createProfile(input: ConnectionInput): Promise<ConnectionProfile> {
  const clean = validate(input);
  const timestamp = now();
  const id = crypto.randomUUID();
  const remember = clean.rememberPassword !== false;
  let passwordEnc: string | null = null;
  if (typeof clean.password === 'string' && clean.password.length > 0) {
    if (remember) passwordEnc = await encryptSecret(clean.password);
    else sessionPasswords.set(id, clean.password);
  }

  const stored: StoredProfile = {
    id,
    name: clean.name,
    host: clean.host,
    port: clean.port,
    user: clean.user,
    database: clean.database ?? null,
    socketPath: clean.socketPath ?? null,
    ssl: cleanSsl(clean.ssl),
    rememberPassword: remember,
    passwordEnc,
    color: clean.color ?? '#ff8a3d',
    databaseScope: clean.databaseScope === 'selected' ? 'selected' : 'all',
    allowedDatabases: clean.allowedDatabases ?? [],
    allowServerWideInsights: clean.allowServerWideInsights !== false,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: null,
  };

  await store.update((current) => ({ profiles: [...current.profiles, stored] }));
  return toPublic(stored);
}

export async function updateProfile(id: string, input: ConnectionInput): Promise<ConnectionProfile> {
  const clean = validate(input);
  let updated: StoredProfile | null = null;

  await store.update(async (current) => {
    const index = current.profiles.findIndex((item) => item.id === id);
    if (index < 0) throw new AppError('PROFILE_NOT_FOUND', 'Connection profile not found.', 404);
    const previous = current.profiles[index];
    const remember = clean.rememberPassword !== false;
    let passwordEnc = previous.passwordEnc ?? null;

    if (typeof clean.password === 'string') {
      if (remember) {
        passwordEnc = clean.password.length > 0 ? await encryptSecret(clean.password) : null;
        sessionPasswords.delete(id);
      } else {
        passwordEnc = null;
        sessionPasswords.set(id, clean.password);
      }
    } else if (remember && !previous.rememberPassword) {
      const session = sessionPasswords.get(id);
      if (session !== undefined) {
        passwordEnc = session.length > 0 ? await encryptSecret(session) : null;
        sessionPasswords.delete(id);
      }
    } else if (!remember && previous.rememberPassword && previous.passwordEnc) {
      const saved = await decryptSecret(previous.passwordEnc);
      if (saved !== null) sessionPasswords.set(id, saved);
      passwordEnc = null;
    }

    updated = {
      ...previous,
      name: clean.name,
      host: clean.host,
      port: clean.port,
      user: clean.user,
      database: clean.database ?? null,
      socketPath: clean.socketPath ?? null,
      ssl: cleanSsl(clean.ssl),
      rememberPassword: remember,
      passwordEnc,
      color: clean.color ?? previous.color ?? '#ff8a3d',
      databaseScope: clean.databaseScope === 'selected' ? 'selected' : 'all',
      allowedDatabases: clean.allowedDatabases ?? [],
      allowServerWideInsights: clean.allowServerWideInsights !== false,
      updatedAt: now(),
    };
    const profiles = [...current.profiles];
    profiles[index] = updated;
    return { profiles };
  });

  if (!updated) throw new AppError('PROFILE_NOT_FOUND', 'Connection profile not found.', 404);
  return toPublic(updated);
}

export async function deleteProfile(id: string): Promise<void> {
  await store.update((current) => {
    if (!current.profiles.some((profile) => profile.id === id)) {
      throw new AppError('PROFILE_NOT_FOUND', 'Connection profile not found.', 404);
    }
    return { profiles: current.profiles.filter((profile) => profile.id !== id) };
  });
  sessionPasswords.delete(id);
}

export async function touchProfile(id: string): Promise<void> {
  await store.update((current) => ({
    profiles: current.profiles.map((profile) =>
      profile.id === id ? { ...profile, lastUsedAt: now() } : profile,
    ),
  }));
}

export async function addDatabaseToScope(
  id: string,
  database: string,
): Promise<ConnectionProfile> {
  let updated: StoredProfile | null = null;
  await store.update((current) => ({
    profiles: current.profiles.map((profile) => {
      if (profile.id !== id) return profile;
      const scope = profile.databaseScope === 'selected' ? 'selected' : 'all';
      const allowed = Array.from(
        new Set([...(profile.allowedDatabases ?? []), database]),
      );
      updated = { ...profile, databaseScope: scope, allowedDatabases: allowed, updatedAt: now() };
      return updated;
    }),
  }));
  if (!updated) throw new AppError('PROFILE_NOT_FOUND', 'Connection profile not found.', 404);
  return toPublic(updated);
}

export async function getProfilePassword(profile: StoredProfile): Promise<string | null> {
  if (sessionPasswords.has(profile.id)) return sessionPasswords.get(profile.id) ?? null;
  if (profile.passwordEnc) return decryptSecret(profile.passwordEnc);
  return null;
}

export function setSessionPassword(id: string, password: string): void {
  sessionPasswords.set(id, password);
}

export async function resolveProfilePassword(id: string): Promise<string> {
  const profile = await getStoredProfile(id);
  const password = await getProfilePassword(profile);
  return password ?? '';
}

/** Used by the connection manager so it can recreate pools after edits. */
export function profileConfigHash(profile: StoredProfile): string {
  return crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        host: profile.host,
        port: profile.port,
        user: profile.user,
        socketPath: profile.socketPath,
        ssl: profile.ssl,
        passwordEnc: profile.passwordEnc,
      }),
    )
    .digest('hex');
}

export type { StoredProfile };
