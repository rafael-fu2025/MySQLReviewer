import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Small JSON document store with in-process serialization and atomic writes.
 * Intended for a single local user, not as a general database.
 */
export class JsonStore<T> {
  private cache: T | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly fallback: () => T,
  ) {}

  async read(): Promise<T> {
    if (this.cache !== null) return this.cache;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as T;
      this.cache = parsed;
      // A document written before the restriction was applied keeps its own
      // permissive ACL; tighten it now that it is known to hold secrets.
      await restrictFileAccess(this.file);
      return parsed;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // A crash between the two renames of the Windows replace path leaves
        // the previous content in `<file>.bak`; recover it instead of starting
        // from an empty document.
        const recovered = await this.recoverFromBackup();
        if (recovered !== null) {
          this.cache = recovered;
          return recovered;
        }
        const value = this.fallback();
        this.cache = value;
        return value;
      }
      if (error instanceof SyntaxError) {
        // Preserve the corrupt file for inspection, then recover with defaults.
        try {
          await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          // Ignore recovery failures.
        }
        const value = this.fallback();
        this.cache = value;
        return value;
      }
      throw error;
    }
  }

  async write(value: T): Promise<T> {
    return this.enqueue(async () => {
      await writeJsonAtomic(this.file, value);
      // Cache a copy: the caller keeps ownership of the object it passed in and
      // must never be able to mutate the cached document behind the store's
      // back.
      this.cache = cloneValue(value);
      return value;
    });
  }

  /**
   * Read-modify-write inside the store's serialization queue. The mutator
   * receives a private copy of the current document, so it can never corrupt
   * the cached state — a failed write leaves the cache and the disk in sync.
   */
  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.read();
      const next = await mutator(cloneValue(current));
      await writeJsonAtomic(this.file, next);
      this.cache = cloneValue(next);
      return next;
    });
  }

  /** Force the next read to hit disk. */
  invalidate(): void {
    this.cache = null;
  }

  private async recoverFromBackup(): Promise<T | null> {
    const backup = `${this.file}.bak`;
    try {
      const raw = await fs.readFile(backup, 'utf8');
      const parsed = JSON.parse(raw) as T;
      try {
        await fs.copyFile(backup, this.file);
        await restrictFileAccess(this.file);
        await fs.rm(backup, { force: true });
      } catch {
        // The backup still holds the content; a failed restore is not fatal.
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Deep copy of a JSON-serialisable document. `undefined` properties are kept
 * so a copy stays indistinguishable from its source.
 */
export function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = cloneValue(entry);
    }
    return copy as unknown as T;
  }
  return value;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const dirRestricted = await ensureRestrictedDirectory(dir);
  // A file that already exists keeps its own (possibly permissive) ACL, so it
  // has to be restricted explicitly; a new file inherits the restricted
  // directory ACL instead.
  const existed = await pathExists(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
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
