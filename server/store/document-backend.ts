import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { DATA_DIR, storageConfig } from '../config';

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Document contract                                                           */
/* -------------------------------------------------------------------------- */

export interface StorageDescription {
  backend: 'file' | 'mysql';
  /** The data directory (file mode) or the schema name (MySQL mode). */
  database: string;
}

/**
 * The persistence primitive behind every JsonStore: a flat space of JSON
 * documents. Keys are the store document names (`users`, `sessions`, ...),
 * values are serialized JSON strings — serialization and parsing stay at the
 * JsonStore layer, so both backends see exactly the same bytes. Implementations
 * must provide one process-wide writer lease before serving writes; JsonStore's
 * in-process queue is not a cross-process lock.
 */
export interface DocumentBackend {
  /** Resolves when the backend can serve documents; throws otherwise. */
  ping(): Promise<void>;
  /** The serialized document, or `null` when the key has no document. */
  read(key: string): Promise<string | null>;
  /** Upserts the serialized document for the key. */
  write(key: string, value: string): Promise<void>;
  /** Deletes the document; deleting an absent key is not an error. */
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  describe(): StorageDescription;
}

/**
 * The documents every JsonStore-backed store persists. In file mode they are
 * `<key>.json` inside the data directory; in MySQL mode they are rows with
 * `document_key = <key>`. Reports and workspace are documents too; legacy
 * per-report files under `data/reports/` are imported by the reports store.
 * `.secret.key` remains a restricted file in both modes and is not a document
 * key.
 */
export const KNOWN_DOCUMENT_KEYS = [
  'activity',
  'audit-schedules',
  'conversations',
  'history',
  'practice',
  'profiles',
  'providers',
  'reports',
  'sessions',
  'settings',
  'snippets',
  'users',
  'workspace',
] as const;

export type DocumentKey = (typeof KNOWN_DOCUMENT_KEYS)[number];

/** Derives the storage key of a document from its legacy file name. */
export function documentKeyForFile(file: string): string {
  const base = path.basename(file);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

/**
 * Pins the file a document key is stored in. Stores construct their JsonStore
 * with an absolute file path and in file mode the backend must write exactly
 * that path (tests use temporary directories), so every JsonStore registers
 * its path here. Unregistered keys resolve to `<DATA_DIR>/<key>.json`. The
 * registry is inert in MySQL mode, where keys are row identifiers.
 */
const registeredDocumentPaths = new Map<string, string>();

export function registerFileDocumentPath(key: string, file: string): void {
  registeredDocumentPaths.set(key, path.resolve(file));
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Atomic writes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Replaces a file atomically: the body is written to a temporary sibling and
 * renamed over the target, and the target is restricted to the current user
 * afterwards. The document content is passed pre-serialized.
 */
export async function writeFileAtomic(file: string, body: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const dirRestricted = await ensureRestrictedDirectory(dir);
  // A file that already exists keeps its own (possibly permissive) ACL, so it
  // has to be restricted explicitly; a new file inherits the restricted
  // directory ACL instead.
  const existed = await pathExists(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    // Reports can contain connection details and SQL, so keep them private.
    await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Windows and some network filesystems cannot apply POSIX modes. The file
    // is still created; do not fail the write over an unsupported mode.
    if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EINVAL') {
      await fs.writeFile(tmp, body, 'utf8');
    } else {
      throw error;
    }
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES') {
      // Windows can refuse rename-over-existing. Move the current document
      // aside instead of deleting it: the previous content stays recoverable in
      // `<file>.bak` if the process dies between the two renames.
      const backup = `${file}.bak`;
      let moved = false;
      try {
        await fs.rename(file, backup);
        moved = true;
      } catch {
        // There is no previous document (or it cannot be moved aside).
      }
      try {
        await fs.rename(tmp, file);
      } catch (renameError) {
        if (moved) await fs.rename(backup, file).catch(() => {});
        await fs.rm(tmp, { force: true });
        throw renameError;
      }
      if (moved) await fs.rm(backup, { force: true });
    } else {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }
  if (!dirRestricted || existed) await restrictFileAccess(file);
}

/* -------------------------------------------------------------------------- */
/* File permissions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Windows ignores POSIX modes, so `mode: 0o600` silently leaves the file with
 * the inherited ACL of its directory — readable by other local accounts. The
 * intended restriction is therefore applied with an explicit ACL.
 */
const WINDOWS_SYSTEM_SID = '*S-1-5-18';
const WINDOWS_ADMINISTRATORS_SID = '*S-1-5-32-544';

const securedDirectories = new Set<string>();
const securedFiles = new Set<string>();
let currentUserSid: string | null = null;

async function resolveCurrentUserSid(): Promise<string | null> {
  if (currentUserSid !== null) return currentUserSid;
  try {
    const { stdout } = await execFileAsync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true,
      timeout: 10_000,
    });
    // The CSV row holds the account name and the SID; only the SID is used,
    // because icacls resolves account names case-sensitively.
    const sid = stdout.match(/S-\d+-\d+(?:-\d+)+/)?.[0];
    if (sid) {
      currentUserSid = `*${sid}`;
      return currentUserSid;
    }
  } catch {
    // Fall through to the account name.
  }
  try {
    currentUserSid = os.userInfo().username;
  } catch {
    currentUserSid = null;
  }
  return currentUserSid;
}

async function runIcacls(target: string, args: string[]): Promise<void> {
  await execFileAsync('icacls', [target, ...args], { windowsHide: true, timeout: 15_000 });
}

/**
 * Restricts a directory to the current user, SYSTEM and the local
 * administrators, so every file created inside inherits a private ACL.
 * Returns true when the restriction was applied.
 */
export async function ensureRestrictedDirectory(dir: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      // Best effort: a directory we cannot tighten is not a reason to fail.
    }
    return true;
  }
  const key = path.resolve(dir);
  if (securedDirectories.has(key)) return true;
  securedDirectories.add(key);
  const owner = await resolveCurrentUserSid();
  const grants = [
    ...(owner ? [`${owner}:(OI)(CI)(F)`] : []),
    `${WINDOWS_SYSTEM_SID}:(OI)(CI)(F)`,
    `${WINDOWS_ADMINISTRATORS_SID}:(OI)(CI)(F)`,
  ];
  try {
    await runIcacls(key, ['/inheritance:r', ...grants.flatMap((grant) => ['/grant:r', grant])]);
    return true;
  } catch (error) {
    securedDirectories.delete(key);
    console.warn(`[mylens] Could not restrict access to ${key}: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Restricts a single file to the current user, SYSTEM and the local
 * administrators. On POSIX this is the intended `0600` mode.
 */
export async function restrictFileAccess(file: string): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(file, 0o600);
    } catch {
      // Best effort.
    }
    return;
  }
  // Canonicalise so the deduplication Set works across equivalent paths.
  // All callers reach this function with a path that was constructed from
  // DATA_DIR (JsonStore, crypto.ts) or from a path explicitly registered via
  // registerFileDocumentPath, so the resolved path is always within the
  // operator-configured data directory.
  const key = path.resolve(file);
  if (securedFiles.has(key)) return;
  securedFiles.add(key);
  const owner = await resolveCurrentUserSid();
  const grants = [
    ...(owner ? [`${owner}:(F)`] : []),
    `${WINDOWS_SYSTEM_SID}:(F)`,
    `${WINDOWS_ADMINISTRATORS_SID}:(F)`,
  ];
  try {
    await runIcacls(key, ['/inheritance:r', ...grants.flatMap((grant) => ['/grant:r', grant])]);
  } catch (error) {
    securedFiles.delete(key);
    console.warn(`[mylens] Could not restrict access to ${file}: ${(error as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* File backend                                                                */
/* -------------------------------------------------------------------------- */

/** Reads the previous content out of `<file>.bak` left by an interrupted write. */
async function recoverFromBackupFile(file: string): Promise<string | null> {
  const backup = `${file}.bak`;
  let raw: string;
  try {
    raw = await fs.readFile(backup, 'utf8');
  } catch {
    return null;
  }
  try {
    await fs.copyFile(backup, file);
    await restrictFileAccess(file);
    await fs.rm(backup, { force: true });
  } catch {
    // The backup still holds the content; a failed restore is not fatal.
  }
  return raw;
}

/** The default backend: one JSON file per document inside the data directory. */
export class FileDocumentBackend implements DocumentBackend {
  async ping(): Promise<void> {
    // Files need no connection; the data directory is created at boot.
  }

  async read(key: string): Promise<string | null> {
    const file = this.resolve(key);
    try {
      const raw = await fs.readFile(file, 'utf8');
      // A document written before the restriction was applied keeps its own
      // permissive ACL; tighten it now that it is known to hold secrets.
      await restrictFileAccess(file);
      return raw;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw error;
    }
    // A crash between the two renames of the Windows replace path leaves the
    // previous content in `<file>.bak`; recover it instead of starting from an
    // empty document.
    return recoverFromBackupFile(file);
  }

  async write(key: string, value: string): Promise<void> {
    await writeFileAtomic(this.resolve(key), value);
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async keys(): Promise<string[]> {
    const found = new Set<string>();
    const entries = await fs.readdir(DATA_DIR).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry.endsWith('.json')) found.add(entry.slice(0, -'.json'.length));
    }
    for (const [key, file] of registeredDocumentPaths) {
      if (await pathExists(file)) found.add(key);
    }
    return [...found].sort();
  }

  describe(): StorageDescription {
    return { backend: 'file', database: DATA_DIR };
  }

  private resolve(key: string): string {
    // Registered paths are explicitly set by server-side code (never from
    // request input) and may live in any directory (e.g. a test temp dir).
    // Unregistered keys always resolve to `<DATA_DIR>/<key>.json`; we validate
    // the resulting canonical path stays inside DATA_DIR to prevent traversal
    // if a malformed key with `..` segments were ever to reach this point.
    if (registeredDocumentPaths.has(key)) {
      return registeredDocumentPaths.get(key) as string;
    }
    const resolved = path.resolve(DATA_DIR, `${key}.json`);
    if (!resolved.startsWith(DATA_DIR + path.sep) && resolved !== DATA_DIR) {
      throw new Error(`FileDocumentBackend: document key resolves outside data directory: ${key}`);
    }
    return resolved;
  }
}

/* -------------------------------------------------------------------------- */
/* MySQL backend                                                               */
/* -------------------------------------------------------------------------- */

const DOCUMENTS_TABLE = 'app_documents';
/**
 * The document row is an application-level JSON aggregate: read/modify/write
 * correctness requires one writer process. This advisory lock is held on a
 * dedicated connection for the backend lifetime and released by close().
 */
const WRITER_LOCK_PREFIX = 'mylens:documents:';
const WRITER_LOCK_TIMEOUT_SECONDS = 0;

const DOCUMENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DOCUMENTS_TABLE} (
  document_key VARCHAR(190) PRIMARY KEY,
  document JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

/**
 * SECURITY: every VALUE in every statement — the document key and the document
 * body — is bound with a `?` placeholder through `execute`. The only text
 * interpolated into SQL are the table name (a code constant above) and the
 * database name (an identifier from the configuration), which cannot be sent
 * as placeholders; the database name is validated against a strict identifier
 * pattern and backtick-quoted before it ever touches a statement.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_$]{1,64}$/;

function quoteIdentifier(name: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`"${name}" is not a valid MySQL identifier for MYLENS_STORE_MYSQL_DATABASE.`);
  }
  return `\`${name}\``;
}

/** A MySQL URI without a database path, so it never selects a schema. */
export function mysqlUriWithoutDatabase(uri: string): string {
  const match = uri.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+/);
  return match ? match[0] : uri;
}

/** The storage URI without credentials, safe to print or log. */
export function redactStorageUri(uri: string): string {
  const stripped = mysqlUriWithoutDatabase(uri);
  const schemeEnd = stripped.indexOf('://');
  if (schemeEnd < 0) return stripped;
  const authority = stripped.slice(schemeEnd + 3);
  const atIndex = authority.lastIndexOf('@');
  if (atIndex < 0) return stripped;
  return `${stripped.slice(0, schemeEnd + 3)}${authority.slice(atIndex + 1)}`;
}

interface DocumentRow extends RowDataPacket {
  document_key: string;
  document: string;
}

export interface MySqlDocumentBackendOptions {
  /**
   * Directory holding the legacy `*.json` documents imported once, on first
   * use, for keys that have no row yet. Defaults to the app data directory;
   * `null` disables the import (used by tests against throwaway databases).
   */
  legacyDataDir?: string | null;
  /** Prints the one-line migration summary; defaults to true. */
  log?: boolean;
}

/**
 * Stores the same JSON documents as rows of one `app_documents` table:
 * `document_key` is the store name, `document` the serialized JSON. The
 * database and the table are created on first use; every statement is
 * parameterized (see the SECURITY note above).
 */
export class MySqlDocumentBackend implements DocumentBackend {
  private readonly uri: string;
  private writerConnection: Connection | null = null;
  private writerLockName: string | null = null;
  private ready: Promise<void> | null = null;
  private readonly legacyDataDir: string | null;
  private readonly log: boolean;

  constructor(
    uri: string,
    private readonly database: string,
    options: MySqlDocumentBackendOptions = {},
  ) {
    // A database named in the URI may not exist yet, and the schema the
    // documents live in is MYLENS_STORE_MYSQL_DATABASE — strip the path so
    // the configured database is the single source of truth.
    this.uri = mysqlUriWithoutDatabase(uri);
    this.legacyDataDir = options.legacyDataDir === undefined ? DATA_DIR : options.legacyDataDir;
    this.log = options.log ?? true;
  }

  async ping(): Promise<void> {
    await this.ensureReady();
    await this.getWriterConnection().query('SELECT 1');
  }

  async read(key: string): Promise<string | null> {
    await this.ensureReady();
    return this.readRow(key);
  }

  async write(key: string, value: string): Promise<void> {
    await this.ensureReady();
    await this.writeRow(key, value);
  }

  async remove(key: string): Promise<void> {
    await this.ensureReady();
    await this.removeRow(key);
  }

  async keys(): Promise<string[]> {
    await this.ensureReady();
    return this.listRowKeys();
  }

  describe(): StorageDescription {
    return { backend: 'mysql', database: this.database };
  }

  /** Releases the process writer lease and its dedicated connection. */
  async close(): Promise<void> {
    const writer = this.writerConnection;
    const lockName = this.writerLockName;
    this.writerConnection = null;
    this.writerLockName = null;
    this.ready = null;
    if (writer) {
      if (lockName) {
        await writer
          .execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
          .catch(() => undefined);
      }
      await writer.end().catch(() => undefined);
    }
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.initialize().catch(async (error) => {
        // A failed first use must not poison the backend: the next call
        // retries schema creation, writer-lock acquisition and legacy import.
        this.ready = null;
        const writer = this.writerConnection;
        this.writerConnection = null;
        this.writerLockName = null;
        if (writer) await writer.end().catch(() => undefined);
        throw error;
      });
    }
    return this.ready;
  }

  private async initialize(): Promise<void> {
    await this.ensureDatabase();
    await this.acquireWriterLock();
    await this.getWriterConnection().query(DOCUMENTS_TABLE_DDL);
    if (this.legacyDataDir !== null) {
      // The import runs through the row primitives directly: the public
      // methods await `ensureReady`, which is initializing right now.
      const migrated = await migrateLegacyFileDocuments(
        {
          ping: async () => {},
          read: (key) => this.readRow(key),
          write: (key, value) => this.writeRow(key, value),
          remove: (key) => this.removeRow(key),
          keys: () => this.listRowKeys(),
          describe: () => this.describe(),
        },
        this.legacyDataDir,
      );
      if (this.log) {
        console.log(
          `[mylens] storage: mysql backend ready; migrated ${migrated} documents from data/`,
        );
      }
    }
  }

  private async acquireWriterLock(): Promise<void> {
    if (this.writerConnection) return;
    const connection = await mysql.createConnection({
      uri: this.uri,
      database: this.database,
      multipleStatements: false,
      namedPlaceholders: false,
      charset: 'utf8mb4',
      connectTimeout: 10_000,
      enableKeepAlive: true,
    });
    const lockName = `${WRITER_LOCK_PREFIX}${crypto
      .createHash('sha256')
      .update(this.database)
      .digest('hex')
      .slice(0, 40)}`;
    try {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT GET_LOCK(?, ?) AS acquired',
        [lockName, WRITER_LOCK_TIMEOUT_SECONDS],
      );
      if (Number(rows[0]?.acquired) !== 1) {
        throw new Error(
          `MyLens document storage for "${this.database}" is already owned by another process. ` +
            'Only one MyLens server may write this JSON document schema at a time.',
        );
      }
      this.writerConnection = connection;
      this.writerLockName = lockName;
    } catch (error) {
      await connection.end().catch(() => undefined);
      throw error;
    }
  }

  private async ensureDatabase(): Promise<void> {
    const database = quoteIdentifier(this.database);
    const connection = await mysql.createConnection(this.uri);
    try {
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
      );
    } finally {
      await connection.end();
    }
  }

  private getWriterConnection(): Connection {
    if (!this.writerConnection) {
      throw new Error('MyLens document storage writer lock is not held.');
    }
    return this.writerConnection;
  }

  private async readRow(key: string): Promise<string | null> {
    const [rows] = await this.getWriterConnection().execute<DocumentRow[]>(
      `SELECT document FROM ${DOCUMENTS_TABLE} WHERE document_key = ?`,
      [key],
    );
    const value = rows[0]?.document;
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return null;
    // Some drivers deliver a JSON column as a parsed value; normalize.
    return JSON.stringify(value);
  }

  private async writeRow(key: string, value: string): Promise<void> {
    await this.getWriterConnection().execute(
      `INSERT INTO ${DOCUMENTS_TABLE} (document_key, document) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE document = VALUES(document)`,
      [key, value],
    );
  }

  private async removeRow(key: string): Promise<void> {
    await this.getWriterConnection().execute(
      `DELETE FROM ${DOCUMENTS_TABLE} WHERE document_key = ?`,
      [key],
    );
  }

  private async listRowKeys(): Promise<string[]> {
    const [rows] = await this.getWriterConnection().execute<DocumentRow[]>(
      `SELECT document_key FROM ${DOCUMENTS_TABLE}`,
    );
    return rows.map((row) => row.document_key);
  }
}

/* -------------------------------------------------------------------------- */
/* Legacy import                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Plans the boot import: for every known document key that has no row yet and
 * whose legacy `data/<key>.json` file exists, the file content becomes one
 * import. Rows that already exist are never touched, corrupt legacy files are
 * skipped (they recover to defaults at read time), and nothing is ever written
 * back from the backend into `data/`.
 */
export async function planLegacyDocumentImports(
  dataDir: string,
  existingKeys: ReadonlySet<string>,
): Promise<Array<{ key: DocumentKey; body: string }>> {
  const imports: Array<{ key: DocumentKey; body: string }> = [];
  for (const key of KNOWN_DOCUMENT_KEYS) {
    if (existingKeys.has(key)) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dataDir, `${key}.json`), 'utf8');
    } catch {
      continue; // No legacy document for this store.
    }
    try {
      JSON.parse(raw);
    } catch {
      continue; // A corrupt legacy document must not become a broken row.
    }
    imports.push({ key, body: raw });
  }
  return imports;
}

/**
 * Applies the boot import against a backend and returns how many documents
 * were imported. The MySQL backend calls this once, on first use, with its
 * row primitives — never through the public methods, which await the very
 * initialization that runs the import.
 */
export async function migrateLegacyFileDocuments(
  backend: DocumentBackend,
  dataDir: string,
): Promise<number> {
  const existing = new Set(await backend.keys());
  const imports = await planLegacyDocumentImports(dataDir, existing);
  for (const entry of imports) {
    await backend.write(entry.key, entry.body);
  }
  return imports.length;
}

/* -------------------------------------------------------------------------- */
/* Backend factory                                                             */
/* -------------------------------------------------------------------------- */

let overrideBackend: DocumentBackend | null = null;
let fileBackend: FileDocumentBackend | null = null;
let mysqlBackend: MySqlDocumentBackend | null = null;

/**
 * Test/diagnostic hook: replaces the process backend until cleared with
 * `null`. Stores capture the backend when they are constructed, so set the
 * override before creating JsonStore instances.
 */
export function setDocumentBackendOverride(backend: DocumentBackend | null): void {
  overrideBackend = backend;
}

/** One backend per process, created lazily from the storage configuration. */
export function getDocumentBackend(): DocumentBackend {
  if (overrideBackend) return overrideBackend;
  if (storageConfig.mode === 'mysql') {
    mysqlBackend ??= new MySqlDocumentBackend(
      storageConfig.mysql.uri,
      storageConfig.mysql.database,
    );
    return mysqlBackend;
  }
  fileBackend ??= new FileDocumentBackend();
  return fileBackend;
}

/** The health payload's `storage` field. Never connects to anything. */
export function describeStorage(): StorageDescription {
  return getDocumentBackend().describe();
}

/** Graceful shutdown: closes the MySQL pool if one was created. */
export async function closeDocumentBackend(): Promise<void> {
  if (mysqlBackend) await mysqlBackend.close();
}
