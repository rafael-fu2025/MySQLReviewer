import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type {
  ConnectionInput,
  DatabaseInfo,
  ServerInfo,
  TestConnectionResult,
  UnlockResult,
} from '../../shared/types';
import { SYSTEM_SCHEMAS } from '../../shared/types';
import { DATA_DIR } from '../config';
import { AppError, isFatalConnectionError, mapDbError } from '../errors';
import {
  profileConfigHash,
  getProfilePassword,
  getStoredProfile,
  touchProfile,
} from '../store/profiles';
import { getServerInfo, applyPoolSession } from './dialect';

interface PoolEntry {
  pool: Pool;
  hash: string;
  lastUsed: number;
  /** The database a fresh connection of this pool selects, if any. */
  defaultDatabase: string | null;
}

const pools = new Map<string, PoolEntry>();
const serverInfoCache = new Map<string, ServerInfo>();

/**
 * Write unlocks are keyed by profile *and* user: one member's unlock must not
 * disarm the write lock for every other user of the same profile.
 */
const unlockedUntil = new Map<string, Map<string, number>>();
/**
 * The profile-wide grant an administrator holds. It is the only grant that
 * applies to callers that cannot name a user.
 */
const adminUnlockedUntil = new Map<string, number>();

export const UNLOCK_TTL_MS = 15 * 60 * 1000;

/**
 * Revoke every write grant on every profile: the personal grants of all users
 * and the profile-wide grants administrators hold.
 *
 * Used when write unlocking is switched off for everybody, so that turning it
 * back on does not resurrect a grant that was still inside its window.
 */
export function revokeAllWriteGrants(): void {
  unlockedUntil.clear();
  adminUnlockedUntil.clear();
}

/**
 * Revoke every write grant held by one user, on every profile.
 *
 * Used when an administrator blocks write unlocking for a single account, so
 * that a grant that account already held does not outlive the block.
 */
export function revokeWriteGrantsForUser(userId: string): void {
  for (const grants of unlockedUntil.values()) {
    grants.delete(userId);
  }
}

/** The grant map of one profile, created on demand. */
function userGrants(profileId: string): Map<string, number> {
  let grants = unlockedUntil.get(profileId);
  if (!grants) {
    grants = new Map<string, number>();
    unlockedUntil.set(profileId, grants);
  }
  return grants;
}

/**
 * SSL material may only be read from the MyLens data directory. A profile
 * that names an arbitrary path would let it read any file on the machine and
 * hand it to the database host.
 *
 * Exported for the test-suite.
 */
export function assertReadableSslPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(DATA_DIR);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError(
      'SSL_FILE_ERROR',
      `SSL files must be stored in the MyLens data directory (${root}).`,
    );
  }
  return resolved;
}

async function buildSslConfig(
  input: ConnectionInput['ssl'] | null,
): Promise<mysql.SslOptions | undefined> {
  if (!input?.enabled) return undefined;
  const readMaybe = async (value: string | undefined): Promise<string | undefined> => {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.includes('BEGIN CERTIFICATE') || trimmed.includes('BEGIN PRIVATE KEY')) {
      return trimmed;
    }
    try {
      return await fs.readFile(assertReadableSslPath(trimmed), 'utf8');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SSL_FILE_ERROR', `Could not read SSL file: ${trimmed}`);
    }
  };
  return {
    rejectUnauthorized: input.rejectUnauthorized !== false,
    ca: await readMaybe(input.ca),
    cert: await readMaybe(input.cert),
    key: await readMaybe(input.key),
  };
}

export async function getPool(profileId: string): Promise<Pool> {
  const profile = await getStoredProfile(profileId);
  const hash = profileConfigHash(profile);
  const existing = pools.get(profileId);
  if (existing && existing.hash === hash) {
    existing.lastUsed = Date.now();
    return existing.pool;
  }
  if (existing) {
    await existing.pool.end().catch(() => undefined);
    pools.delete(profileId);
    serverInfoCache.delete(profileId);
  }

  const password = (await getProfilePassword(profile)) ?? '';
  const ssl = await buildSslConfig(profile.ssl);
  const pool = mysql.createPool({
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password,
    socketPath: profile.socketPath ?? undefined,
    ssl,
    waitForConnections: true,
    connectionLimit: 4,
    maxIdle: 4,
    idleTimeout: 60_000,
    queueLimit: 0,
    connectTimeout: 10_000,
    multipleStatements: false,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: false,
    timezone: 'local',
  });

  const emitter = pool as unknown as {
    on?: (event: string, listener: (conn: { promise: () => PoolConnection }) => void) => void;
  };
  emitter.on?.('connection', (rawConnection) => {
    void applyPoolSession(rawConnection.promise()).catch(() => undefined);
  });

  pools.set(profileId, {
    pool,
    hash,
    lastUsed: Date.now(),
    defaultDatabase: profile.database?.trim() || null,
  });
  return pool;
}

export async function testConnection(
  input: ConnectionInput,
  options: { includeDatabases?: boolean } = {},
): Promise<TestConnectionResult> {
  const started = Date.now();
  let connection: mysql.Connection | null = null;
  try {
    const ssl = await buildSslConfig(input.ssl);
    connection = await mysql.createConnection({
      host: input.host.trim() || '127.0.0.1',
      port: Number(input.port) || 3306,
      user: input.user.trim(),
      password: input.password ?? '',
      database: input.database?.trim() || undefined,
      socketPath: input.socketPath?.trim() || undefined,
      ssl,
      connectTimeout: 10_000,
      multipleStatements: false,
      charset: 'utf8mb4',
    });
    const server = await getServerInfo(connection as unknown as PoolConnection);
    let databases: DatabaseInfo[] | undefined;
    if (options.includeDatabases) {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT SCHEMA_NAME, DEFAULT_COLLATION_NAME
         FROM information_schema.SCHEMATA
         ORDER BY SCHEMA_NAME`,
      );
      databases = rows.map((row) => {
        const name = String(row.SCHEMA_NAME ?? '');
        return {
          name,
          isSystem: SYSTEM_SCHEMAS.includes(name) || name.startsWith('_aria'),
          tableCount: 0,
          viewCount: 0,
          sizeBytes: 0,
          collation: row.DEFAULT_COLLATION_NAME == null ? null : String(row.DEFAULT_COLLATION_NAME),
        };
      });
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      server,
      database: input.database?.trim() || null,
      databases,
    };
  } catch (error) {
    const mapped = mapDbError(error);
    return {
      ok: false,
      latencyMs: Date.now() - started,
      server: null,
      database: null,
      error: mapped.message,
    };
  } finally {
    if (connection) await connection.end().catch(() => undefined);
  }
}

export async function connectProfile(profileId: string): Promise<ServerInfo> {
  const pool = await getPool(profileId);
  const defaultDatabase = pools.get(profileId)?.defaultDatabase ?? null;
  let connection: PoolConnection | null = null;
  try {
    connection = await pool.getConnection();
    const info = await getServerInfo(connection);
    serverInfoCache.set(profileId, info);
    await touchProfile(profileId);
    return info;
  } catch (error) {
    // A single failed attempt must not tear the pool down: the pooled
    // connections are serving other requests right now. Only the failed
    // connection dies, and the pool stays for the next attempt.
    serverInfoCache.delete(profileId);
    throw mapDbError(error);
  } finally {
    if (connection) {
      const reset = await resetConnectionForPool(connection, defaultDatabase);
      if (reset) connection.release();
      else connection.destroy();
    }
  }
}

export function getCachedServerInfo(profileId: string): ServerInfo | null {
  return serverInfoCache.get(profileId) ?? null;
}

export interface ConnectionReleaseOptions {
  /**
   * Roll back any transaction the statement may have left open before the
   * connection returns to the pool. Pooled connections are reused, so an
   * unreleased transaction would leak row locks into later requests.
   *
   * @deprecated The session state is now reset on every release; the option
   * is kept so existing callers keep working.
   */
  rollbackOnRelease?: boolean;
}

/**
 * Best-effort cleanup of session state that must not survive a pooled
 * connection. `ROLLBACK` is a no-op when no transaction is open, and it runs
 * before `autocommit` is restored so that restoring it cannot implicitly
 * commit anything (unlike an unconditional COMMIT).
 *
 * The selected database is session state too: a request that selects a
 * database must not leave it selected for the next request that borrows the
 * same connection. The connection is restored to the state a fresh connection
 * of this pool would have.
 *
 * Exported for the test-suite.
 */
export async function resetConnectionForPool(
  connection: PoolConnection,
  defaultDatabase: string | null,
): Promise<boolean> {
  try {
    await connection.query('ROLLBACK');
  } catch {
    return false;
  }
  try {
    await connection.query('SET SESSION autocommit = 1');
  } catch {
    return false;
  }
  try {
    if (defaultDatabase) {
      await connection.query('USE ??', [defaultDatabase]);
      return true;
    }
    // The pool has no default database, so the connection must go back to
    // "no database selected".
    const [rows] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS db');
    const selected = rows[0]?.db == null ? null : String(rows[0].db);
    if (selected === null) return true;
    // Re-authenticating resets the session, including the selected database.
    await connection.changeUser({});
    await applyPoolSession(connection);
    return true;
  } catch {
    // Some servers refuse the re-authentication. COM_RESET_CONNECTION resets
    // the session as well and is understood by MySQL 5.7.3 and newer.
    try {
      await connection.reset();
      await applyPoolSession(connection);
      return true;
    } catch {
      return false;
    }
  }
}

export async function withConnection<T>(
  profileId: string,
  fn: (conn: PoolConnection) => Promise<T>,
  _options: ConnectionReleaseOptions = {},
): Promise<T> {
  const pool = await getPool(profileId);
  const defaultDatabase = pools.get(profileId)?.defaultDatabase ?? null;
  const connection = await pool.getConnection();
  let fatal = false;
  try {
    return await fn(connection);
  } catch (error) {
    fatal = isFatalConnectionError(error);
    throw error;
  } finally {
    if (fatal) {
      connection.destroy();
    } else {
      // The reset is authoritative: a pooled connection is only handed back
      // when its session state is known to be clean.
      const reset = await resetConnectionForPool(connection, defaultDatabase);
      if (reset) connection.release();
      else connection.destroy();
    }
  }
}

export async function invalidateProfile(profileId: string): Promise<void> {
  const entry = pools.get(profileId);
  if (entry) {
    await entry.pool.end().catch(() => undefined);
    pools.delete(profileId);
  }
  serverInfoCache.delete(profileId);
  unlockedUntil.delete(profileId);
  adminUnlockedUntil.delete(profileId);
}

export async function disconnectProfile(profileId: string): Promise<void> {
  await invalidateProfile(profileId);
}

export function unlockWrites(
  profileId: string,
  userId: string,
  phrase: string,
  options: { profileWide?: boolean } = {},
): UnlockResult {
  if (phrase.trim().toUpperCase() !== 'UNLOCK WRITES') {
    throw new AppError(
      'CONFIRMATION_REQUIRED',
      'Type "UNLOCK WRITES" exactly to enable write statements for this connection.',
      400,
    );
  }
  const until = Date.now() + UNLOCK_TTL_MS;
  userGrants(profileId).set(userId, until);
  // An administrator may open the connection for everybody; a member's grant
  // stays with that member.
  if (options.profileWide) adminUnlockedUntil.set(profileId, until);
  return {
    unlocked: true,
    until: new Date(until).toISOString(),
    ttlSeconds: Math.floor(UNLOCK_TTL_MS / 1000),
  };
}

export function lockWrites(
  profileId: string,
  userId: string,
  options: { profileWide?: boolean } = {},
): UnlockResult {
  unlockedUntil.get(profileId)?.delete(userId);
  if (options.profileWide) adminUnlockedUntil.delete(profileId);
  return { unlocked: false, until: null, ttlSeconds: 0 };
}

function grantActive(grants: Map<string, number> | undefined, key: string): number | null {
  if (!grants) return null;
  const until = grants.get(key);
  if (until === undefined) return null;
  if (Date.now() >= until) {
    grants.delete(key);
    return null;
  }
  return until;
}

/**
 * Whether write statements are unlocked.
 *
 * `userId` identifies the user the check is made for: the grant belongs to
 * one user and must not leak to the others. A caller that cannot name a user
 * only sees the profile-wide grant an administrator holds.
 */
export function isWritesUnlocked(profileId: string, userId?: string | null): boolean {
  if (userId) {
    return grantActive(unlockedUntil.get(profileId), userId) !== null;
  }
  return grantActive(adminUnlockedUntil, profileId) !== null;
}

export function unlockState(profileId: string, userId?: string | null): UnlockResult {
  const until = userId
    ? grantActive(unlockedUntil.get(profileId), userId)
    : grantActive(adminUnlockedUntil, profileId);
  if (until === null) {
    return { unlocked: false, until: null, ttlSeconds: 0 };
  }
  return {
    unlocked: true,
    until: new Date(until).toISOString(),
    ttlSeconds: Math.max(0, Math.floor((until - Date.now()) / 1000)),
  };
}

export async function shutdownPools(): Promise<void> {
  const entries = Array.from(pools.values());
  pools.clear();
  serverInfoCache.clear();
  await Promise.allSettled(entries.map((entry) => entry.pool.end()));
}
