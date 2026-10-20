import fs from 'node:fs/promises';
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
import { AppError, isFatalConnectionError, mapDbError } from '../errors';
import { profileConfigHash, getProfilePassword, getStoredProfile, touchProfile, setSessionPassword } from '../store/profiles';
import { getServerInfo, applyPoolSession } from './dialect';

interface PoolEntry {
  pool: Pool;
  hash: string;
  lastUsed: number;
}

const pools = new Map<string, PoolEntry>();
const serverInfoCache = new Map<string, ServerInfo>();
const unlockedUntil = new Map<string, number>();

export const UNLOCK_TTL_MS = 15 * 60 * 1000;

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
      return await fs.readFile(trimmed, 'utf8');
    } catch {
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
    on?: (
      event: string,
      listener: (conn: { promise: () => PoolConnection }) => void,
    ) => void;
  };
  emitter.on?.('connection', (rawConnection) => {
    void applyPoolSession(rawConnection.promise()).catch(() => undefined);
  });

  pools.set(profileId, { pool, hash, lastUsed: Date.now() });
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
          collation: row.DEFAULT_COLLATION_NAME == null
            ? null
            : String(row.DEFAULT_COLLATION_NAME),
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

export async function connectProfile(
  profileId: string,
  passwordOverride?: string,
): Promise<ServerInfo> {
  if (typeof passwordOverride === 'string') setSessionPassword(profileId, passwordOverride);
  const pool = await getPool(profileId);
  const connection = await pool.getConnection();
  try {
    const info = await getServerInfo(connection);
    serverInfoCache.set(profileId, info);
    await touchProfile(profileId);
    return info;
  } catch (error) {
    await pool.end().catch(() => undefined);
    pools.delete(profileId);
    serverInfoCache.delete(profileId);
    throw mapDbError(error);
  } finally {
    connection.release();
  }
}

export function getCachedServerInfo(profileId: string): ServerInfo | null {
  return serverInfoCache.get(profileId) ?? null;
}

export async function withConnection<T>(
  profileId: string,
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const pool = await getPool(profileId);
  const connection = await pool.getConnection();
  let fatal = false;
  try {
    return await fn(connection);
  } catch (error) {
    fatal = isFatalConnectionError(error);
    throw error;
  } finally {
    if (fatal) connection.destroy();
    else connection.release();
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
}

export async function disconnectProfile(profileId: string): Promise<void> {
  await invalidateProfile(profileId);
}

export function unlockWrites(profileId: string, phrase: string): UnlockResult {
  if (phrase.trim().toUpperCase() !== 'UNLOCK WRITES') {
    throw new AppError(
      'CONFIRMATION_REQUIRED',
      'Type "UNLOCK WRITES" exactly to enable write statements for this connection.',
      400,
    );
  }
  const until = Date.now() + UNLOCK_TTL_MS;
  unlockedUntil.set(profileId, until);
  return {
    unlocked: true,
    until: new Date(until).toISOString(),
    ttlSeconds: Math.floor(UNLOCK_TTL_MS / 1000),
  };
}

export function lockWrites(profileId: string): UnlockResult {
  unlockedUntil.delete(profileId);
  return { unlocked: false, until: null, ttlSeconds: 0 };
}

export function isWritesUnlocked(profileId: string): boolean {
  const until = unlockedUntil.get(profileId);
  if (!until) return false;
  if (Date.now() >= until) {
    unlockedUntil.delete(profileId);
    return false;
  }
  return true;
}

export function unlockState(profileId: string): UnlockResult {
  if (!isWritesUnlocked(profileId)) {
    return { unlocked: false, until: null, ttlSeconds: 0 };
  }
  const until = unlockedUntil.get(profileId) ?? 0;
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
