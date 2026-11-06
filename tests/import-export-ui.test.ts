import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import {
  dbApi,
  runImportStatements,
  shortenSql,
  type ImportStatementPreview,
} from '../src/lib/db-api';

function statement(
  sql: string,
  overrides: Partial<ImportStatementPreview> = {},
): ImportStatementPreview {
  return {
    sql,
    kind: 'write',
    needsUnlock: true,
    destructive: false,
    ...overrides,
  };
}

describe('shortenSql', () => {
  it('folds a statement onto one line', () => {
    expect(shortenSql('SELECT  *\n  FROM   users')).toBe('SELECT * FROM users');
  });

  it('keeps a short statement whole', () => {
    expect(shortenSql('DROP TABLE IF EXISTS `users`;')).toBe('DROP TABLE IF EXISTS `users`;');
  });

  it('cuts a long statement and marks the cut', () => {
    const short = shortenSql('a'.repeat(200), 20);
    expect(short).toHaveLength(20);
    expect(short.endsWith('...')).toBe(true);
  });
});

describe('runImportStatements', () => {
  it('skips a session statement instead of running it', async () => {
    const ran: string[] = [];
    const outcomes = await runImportStatements(
      [
        statement('SET FOREIGN_KEY_CHECKS = 0;', { kind: 'admin', session: true }),
        statement('CREATE TABLE t (a INT);', { kind: 'ddl' }),
        statement('USE `other`;', { kind: 'admin', session: true }),
      ],
      async (entry) => {
        ran.push(entry.sql);
      },
    );
    // Only the real statement ran; the two session settings were skipped.
    expect(ran).toEqual(['CREATE TABLE t (a INT);']);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'ok', 'skipped']);
  });
  it('runs every statement in the order it was reviewed', async () => {
    const ran: string[] = [];
    const statements = [statement('a'), statement('b'), statement('c')];
    const outcomes = await runImportStatements(statements, async (item) => {
      ran.push(item.sql);
    });
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('waits for one statement before the next one starts', async () => {
    const order: string[] = [];
    const statements = [statement('a'), statement('b')];
    await runImportStatements(statements, async (item) => {
      order.push(`start:${item.sql}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${item.sql}`);
    });
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('carries on after a failure and reports it', async () => {
    const statements = [statement('a'), statement('b'), statement('c')];
    const outcomes = await runImportStatements(statements, async (item) => {
      if (item.sql === 'b') throw new ApiError('SQL_ERROR', 'Table already exists', 400);
    });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'failed', 'ok']);
    expect(outcomes[1].code).toBe('SQL_ERROR');
    expect(outcomes[1].error).toBe('Table already exists');
  });

  it('keeps the write-lock code so the client can say it once', async () => {
    const statements = [statement('a'), statement('b')];
    const outcomes = await runImportStatements(statements, async () => {
      throw new ApiError('WRITE_LOCKED', 'Writes are locked.', 403);
    });
    expect(outcomes.every((outcome) => outcome.code === 'WRITE_LOCKED')).toBe(true);
    expect(outcomes.every((outcome) => outcome.status === 'failed')).toBe(true);
  });

  it('reports each outcome as it happens', async () => {
    const seen: number[] = [];
    const statements = [statement('a'), statement('b')];
    await runImportStatements(
      statements,
      async () => undefined,
      (index) => {
        seen.push(index);
      },
    );
    expect(seen).toEqual([0, 1]);
  });

  it('does nothing for an empty script', async () => {
    expect(await runImportStatements([], async () => undefined)).toEqual([]);
  });
});

describe('dbApi import and export', () => {
  async function capture(
    run: () => Promise<unknown>,
  ): Promise<{ url: string; body: Record<string, unknown> }[]> {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          data: {
            sql: 'SELECT 1;',
            filename: 'shop.sql',
            stats: { tables: 1, views: 0, triggers: 0, routines: 0, rows: 0, bytes: 9 },
            statements: [],
            needsUnlockCount: 0,
            destructiveCount: 0,
            hasDelimiter: false,
            bytes: 9,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
    return calls;
  }

  it('posts the export options to the database export endpoint', async () => {
    const calls = await capture(() =>
      dbApi.exportDatabase('profile 1', 'shop', {
        includeData: true,
        includeObjects: false,
        rowLimit: 10,
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/db/profile%201/databases/shop/export');
    expect(calls[0].body).toEqual({ includeData: true, includeObjects: false, rowLimit: 10 });
  });

  it('defaults the export to schema without rows and with the objects', async () => {
    const calls = await capture(() => dbApi.exportDatabase('p', 'shop'));
    expect(calls[0].body).toEqual({ includeData: false, includeObjects: true });
  });

  it('posts the script to the import preview endpoint', async () => {
    const calls = await capture(() =>
      dbApi.previewImport('p', { sql: 'SELECT 1;', database: 'shop' }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/db/p/import/preview');
    expect(calls[0].body).toEqual({ sql: 'SELECT 1;', database: 'shop' });
  });

  it('sends a null database when the script has no target', async () => {
    const calls = await capture(() => dbApi.previewImport('p', { sql: 'SELECT 1;' }));
    expect(calls[0].body).toEqual({ sql: 'SELECT 1;', database: null });
  });
});
