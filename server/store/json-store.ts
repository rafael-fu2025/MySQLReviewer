import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
      return parsed;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
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
      this.cache = value;
      return value;
    });
  }

  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.read();
      const next = await mutator(current);
      await writeJsonAtomic(this.file, next);
      this.cache = next;
      return next;
    });
  }

  /** Force the next read to hit disk. */
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

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, body, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES') {
      // Windows can refuse rename-over-existing; fall back to replace.
      await fs.rm(file, { force: true });
      await fs.rename(tmp, file);
    } else {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }
}
