import fs from 'node:fs/promises';
import {
  documentKeyForFile,
  getDocumentBackend,
  registerFileDocumentPath,
  writeFileAtomic,
  type DocumentBackend,
} from './document-backend';

export { ensureRestrictedDirectory, restrictFileAccess } from './document-backend';

/**
 * Small JSON document store with in-process serialization and atomic writes.
 * Intended for a single local user, not as a general database.
 *
 * Documents are persisted through the shared `DocumentBackend` — one JSON file
 * per store in the data directory by default, or rows of a `mylens` schema on
 * MySQL when `MYLENS_STORE=mysql`. The key is the store's document name (the
 * file stem, e.g. `users`); serialized JSON strings cross the backend boundary
 * and parsing happens here, so both backends see the same bytes.
 */
export class JsonStore<T> {
  private cache: T | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly backend: DocumentBackend;
  private readonly key: string;
  /** True when documents live in files and file-specific recovery applies. */
  private readonly fileMode: boolean;

  constructor(
    private readonly file: string,
    private readonly fallback: () => T,
  ) {
    this.key = documentKeyForFile(file);
    this.backend = getDocumentBackend();
    registerFileDocumentPath(this.key, file);
    this.fileMode = this.backend.describe().backend === 'file';
  }

  async read(): Promise<T> {
    if (this.cache !== null) return this.cache;
    const raw = await this.backend.read(this.key);
    if (raw === null) {
      const value = this.fallback();
      this.cache = value;
      return value;
    }
    try {
      const parsed = JSON.parse(raw) as T;
      this.cache = parsed;
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        if (this.fileMode) {
          // Preserve the corrupt file for inspection, then recover with
          // defaults. (A JSON column cannot hold invalid JSON, so this path
          // only exists in file mode.)
          try {
            await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
          } catch {
            // Ignore recovery failures.
          }
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
      await this.backend.write(this.key, serializeDocument(value));
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
   * the cached state — a failed write leaves the cache and the storage in sync.
   */
  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.read();
      const next = await mutator(cloneValue(current));
      await this.backend.write(this.key, serializeDocument(next));
      this.cache = cloneValue(next);
      return next;
    });
  }

  /** Force the next read to hit the backend. */
  invalidate(): void {
    this.cache = null;
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

/** Serializes a document exactly as it is stored on disk in file mode. */
function serializeDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, serializeDocument(value));
}
