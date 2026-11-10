import { randomBytes } from 'node:crypto';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA_DIR } from '../server/config';
import {
  FileDocumentBackend,
  KNOWN_DOCUMENT_KEYS,
  MySqlDocumentBackend,
  describeStorage,
  documentKeyForFile,
  migrateLegacyFileDocuments,
  mysqlUriWithoutDatabase,
  registerFileDocumentPath,
  setDocumentBackendOverride,
  type DocumentBackend,
} from '../server/store/document-backend';
import { JsonStore } from '../server/store/json-store';

/** A DocumentBackend holding the serialized documents in memory. */
class InMemoryDocumentBackend implements DocumentBackend {
  readonly rows = new Map<string, string>();

  async ping(): Promise<void> {}

  async read(key: string): Promise<string | null> {
    return this.rows.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.rows.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.rows.keys()].sort();
  }

  describe() {
    return { backend: 'mysql' as const, database: 'in-memory' };
  }
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe('document keys', () => {
  it('derives the storage key from the store file name', () => {
    expect(documentKeyForFile(path.join('data', 'users.json'))).toBe('users');
    expect(documentKeyForFile(path.join(DATA_DIR, 'audit-schedules.json'))).toBe('audit-schedules');
    expect(documentKeyForFile(path.join(DATA_DIR, 'settings.json'))).toBe('settings');
  });

  it('covers exactly the JsonStore-backed stores', () => {
    expect([...KNOWN_DOCUMENT_KEYS].sort()).toEqual([
      'activity',
      'audit-schedules',
      'conversations',
      'history',
      'practice',
      'profiles',
      'providers',
      'sessions',
      'settings',
      'snippets',
      'users',
    ]);
    for (const key of KNOWN_DOCUMENT_KEYS) {
      expect(documentKeyForFile(path.join(DATA_DIR, `${key}.json`))).toBe(key);
    }
  });

  it('describes the default file backend with the data directory', () => {
    expect(describeStorage()).toEqual({ backend: 'file', database: DATA_DIR });
  });
});

describe('legacy document migration', () => {
  it('imports a legacy file only when the row is missing', async () => {
    const dir = await tempDir('mylens-migrate-');
    const backend = new InMemoryDocumentBackend();
    try {
      const usersBody = `${JSON.stringify({ users: [{ id: 'u1' }] }, null, 2)}\n`;
      const sessionsBody = '{"sessions":[]}';
      await fs.writeFile(path.join(dir, 'users.json'), usersBody, 'utf8');
      await fs.writeFile(path.join(dir, 'sessions.json'), sessionsBody, 'utf8');
      await fs.writeFile(path.join(dir, 'settings.json'), 'not json', 'utf8');
      // A row that already exists must never be replaced by the import.
      await backend.write('sessions', sessionsBody);

      const imported = await migrateLegacyFileDocuments(backend, dir);

      expect(imported).toBe(1);
      // The legacy bytes are imported verbatim.
      expect(await backend.read('users')).toBe(usersBody);
      expect(await backend.read('sessions')).toBe(sessionsBody);
      // A corrupt legacy file recovers to defaults instead of a broken row,
      // and a store without a legacy file simply has no row.
      expect(await backend.read('settings')).toBeNull();
      expect(await backend.read('snippets')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second boot finds every row present', async () => {
    const dir = await tempDir('mylens-migrate2-');
    const backend = new InMemoryDocumentBackend();
    try {
      await fs.writeFile(path.join(dir, 'users.json'), '{"users":[]}', 'utf8');
      expect(await migrateLegacyFileDocuments(backend, dir)).toBe(1);
      expect(await migrateLegacyFileDocuments(backend, dir)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('JsonStore over an injected backend', () => {
  it('round-trips a document through the backend', async () => {
    const backend = new InMemoryDocumentBackend();
    setDocumentBackendOverride(backend);
    const dir = await tempDir('mylens-store-');
    try {
      const store = new JsonStore<{ value: number; note: string }>(
        path.join(dir, 'probe.json'),
        () => ({ value: 0, note: '' }),
      );

      // No row yet: the fallback applies, and nothing is persisted by a read.
      expect(await store.read()).toEqual({ value: 0, note: '' });
      expect(await backend.read('probe')).toBeNull();

      await store.write({ value: 1, note: 'héllo' });
      // The store serializes; the backend stores the JSON string with the
      // exact bytes the file backend would have written.
      expect(await backend.read('probe')).toBe(
        `${JSON.stringify({ value: 1, note: 'héllo' }, null, 2)}\n`,
      );

      store.invalidate();
      expect(await store.read()).toEqual({ value: 1, note: 'héllo' });

      await store.update((current) => ({ ...current, value: current.value + 6 }));
      expect(JSON.parse((await backend.read('probe')) as string)).toEqual({
        value: 7,
        note: 'héllo',
      });

      // A removed document falls back on the next read.
      await backend.remove('probe');
      store.invalidate();
      expect(await store.read()).toEqual({ value: 0, note: '' });
    } finally {
      setDocumentBackendOverride(null);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('FileDocumentBackend', () => {
  it('round-trips documents at the registered path and lists keys', async () => {
    const dir = await tempDir('mylens-file-');
    registerFileDocumentPath('probe-file', path.join(dir, 'probe-file.json'));
    const backend = new FileDocumentBackend();
    try {
      await backend.write('probe-file', '{"a":1}\n');
      expect(await backend.read('probe-file')).toBe('{"a":1}\n');
      expect(await backend.read('missing-document')).toBeNull();
      expect(await backend.keys()).toContain('probe-file');

      await backend.remove('probe-file');
      expect(await backend.read('probe-file')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* MySQL integration — runs only when MYLENS_TEST_MYSQL_URI is set. The tests  */
/* use a throwaway database (dropped afterwards) and connect through one pool  */
/* for the whole file.                                                         */
/* -------------------------------------------------------------------------- */

const TEST_URI = process.env.MYLENS_TEST_MYSQL_URI;

describe.skipIf(!TEST_URI)('MySqlDocumentBackend — integration', () => {
  // The block body runs even when skipped, so keep derivation total.
  const uri = TEST_URI ?? '';
  const suffix = randomBytes(4).toString('hex');
  const uriDatabase = uri.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/([^/?#]+)/)?.[1];
  const database = `${uriDatabase ?? 'mylens'}_probe_${suffix}`;
  let backend: MySqlDocumentBackend | undefined;
  let admin: Connection | undefined;

  beforeAll(async () => {
    admin = await mysql.createConnection(mysqlUriWithoutDatabase(uri));
    backend = new MySqlDocumentBackend(uri, database, { legacyDataDir: null, log: false });
    await backend.ping();
  });

  afterAll(async () => {
    try {
      if (admin) {
        await admin.execute(`DROP DATABASE IF EXISTS \`${database}\``);
        await admin.end();
      }
    } finally {
      if (backend) await backend.close();
    }
  });

  it('auto-creates the database and the documents table on first use', async () => {
    const [schemas] = await admin!.execute<RowDataPacket[]>(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database],
    );
    expect(schemas).toHaveLength(1);
    const [tables] = await admin!.execute<RowDataPacket[]>(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [database, 'app_documents'],
    );
    expect(tables).toHaveLength(1);
  });

  it('describes the mysql backend with its database', () => {
    expect(backend!.describe()).toEqual({ backend: 'mysql', database });
  });

  it('round-trips, overwrites, lists and removes documents', async () => {
    const document = {
      value: 1,
      note: 'héllo 世界',
      nested: { list: [1, 2, 3], flag: true },
    };

    // A missing document reads as null before anything is written.
    expect(await backend!.read('probe-doc')).toBeNull();

    await backend!.write('probe-doc', JSON.stringify(document));
    expect(JSON.parse((await backend!.read('probe-doc')) as string)).toEqual(document);

    // Overwrite: an upsert replaces the document, it does not duplicate it.
    const updated = { ...document, value: 2 };
    await backend!.write('probe-doc', JSON.stringify(updated));
    expect(JSON.parse((await backend!.read('probe-doc')) as string)).toEqual(updated);

    await backend!.write('probe-other', '{"x":1}');
    const keys = await backend!.keys();
    expect(keys).toContain('probe-doc');
    expect(keys).toContain('probe-other');

    await backend!.remove('probe-doc');
    expect(await backend!.read('probe-doc')).toBeNull();
    expect(await backend!.keys()).not.toContain('probe-doc');
    expect(await backend!.keys()).toContain('probe-other');
  });
});
