import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { resolveStatementTimeoutMode, startStatementWatchdog } from '../server/db/dialect';
import { formatGrantStatement } from '../server/db/security-audit';
import { redactStatementLiterals } from '../server/db/query';
import { getTableData } from '../server/db/introspection';
import { provisionSandbox } from '../server/db/provision';
import { explorerRouter } from '../server/routes/explorer';

/**
 * Shared fixtures for the database-layer policy tests. Every database call is
 * faked, so the suite never needs a live MySQL server.
 */
const h = vi.hoisted(() => ({
  unlocked: false,
  conn: null as { threadId: number; query: unknown } | null,
  calls: [] as { sql: string; values?: unknown[]; timeout?: number }[],
  history: [] as { sql: string }[],
  guardCalls: [] as {
    rowLimit: number;
    queryTimeoutMs: number;
    isReadOnly?: boolean;
    includeRowLimit?: boolean;
  }[],
  server: {
    flavor: 'mysql' as 'mysql' | 'mariadb',
    version: '8.0.36',
    versionComment: 'MySQL Community Server - GPL',
    uptimeSeconds: 10,
    sqlMode: 'STRICT_TRANS_TABLES',
    currentDatabase: null,
    capabilities: {
      cte: true,
      windowFunctions: true,
      json: true,
      checkConstraints: true,
      roles: true,
      explainAnalyze: true,
      analyzeFormatJson: false,
      performanceSchema: true,
      sysSchema: true,
      replicaStatusCommand: 'SHOW REPLICA STATUS' as const,
      mysql8: true,
    },
  },
  settings: {
    theme: 'dark' as const,
    rowLimit: 1000,
    queryTimeoutMs: 30_000,
    cellMaxChars: 16_384,
    liveLint: true,
    includeSchemaByDefault: true,
    aiContextChars: 24_000,
    defaultAiProviderId: null,
    historyLimit: 500,
    showHints: true,
    maskSensitiveColumns: true,
  },
}));

vi.mock('../server/db/manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/manager')>();
  return {
    ...actual,
    isWritesUnlocked: () => h.unlocked,
    getCachedServerInfo: () => h.server,
    connectProfile: async () => h.server,
    getPool: async () =>
      ({
        getConnection: async () => ({
          query: async () => [{}, []],
          release: () => undefined,
        }),
      }) as unknown as Pool,
    withConnection: async (_profileId: string, fn: (conn: unknown) => Promise<unknown>) =>
      fn(h.conn),
  };
});

vi.mock('../server/db/dialect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/dialect')>();
  return {
    ...actual,
    applyQueryGuards: (async (
      _conn: unknown,
      _server: unknown,
      settings: { rowLimit: number; queryTimeoutMs: number },
      options?: { isReadOnly?: boolean; includeRowLimit?: boolean },
    ) => {
      h.guardCalls.push({ ...settings, ...options });
      return { cleanup: async () => undefined };
    }) as unknown as typeof actual.applyQueryGuards,
  };
});

vi.mock('../server/db/scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/scope')>();
  return { ...actual, assertSqlScope: async () => undefined };
});

vi.mock('../server/store/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/settings')>();
  return { ...actual, getSettings: async () => h.settings };
});

vi.mock('../server/store/profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/profiles')>();
  return {
    ...actual,
    getStoredProfile: (async () => ({
      id: 'p1',
      database: 'shop',
    })) as unknown as typeof actual.getStoredProfile,
  };
});

vi.mock('../server/store/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/store/history')>();
  return {
    ...actual,
    addHistory: (async (input: { sql: string }) => {
      h.history.push({ sql: input.sql });
      return { ...input, id: 'entry-1' } as never;
    }) as unknown as typeof actual.addHistory,
  };
});

type QueryHandler = (sql: string, values?: unknown[]) => unknown;

function fakeConn(handler: QueryHandler): { threadId: number; query: unknown } {
  return {
    threadId: 7,
    query: vi.fn(async (arg: unknown, values?: unknown[]) => {
      const isString = typeof arg === 'string';
      const sql = isString ? arg : String((arg as { sql: string }).sql);
      const effectiveValues = isString ? values : (arg as { values?: unknown[] }).values;
      const timeout = isString ? undefined : (arg as { timeout?: number }).timeout;
      h.calls.push({ sql, values: effectiveValues, timeout });
      return handler(sql, effectiveValues);
    }),
  };
}

function resetState(): void {
  h.unlocked = false;
  h.conn = null;
  h.calls = [];
  h.history = [];
  h.guardCalls = [];
  h.server.flavor = 'mysql';
}

/* ------------------------------------------------------------------ */
/* D-04 — the table-data path must honour the reveal lock             */
/* ------------------------------------------------------------------ */

describe('D-04 — revealing masked values is a write-level action', () => {
  it('refuses revealSensitive on the table-data path while writes are locked', async () => {
    resetState();
    h.conn = fakeConn(() => {
      throw new Error('the database must not be touched');
    });

    await expect(
      getTableData('p1', 'shop', 'users', { revealSensitive: true }),
    ).rejects.toMatchObject({ code: 'REVEAL_LOCKED' });
    expect(h.calls).toHaveLength(0);
  });

  it('keeps masking table rows while writes are locked', async () => {
    resetState();
    h.conn = fakeConn((sql) => {
      if (sql.includes('information_schema.COLUMNS')) {
        return [[{ COLUMN_NAME: 'password' }], []];
      }
      if (sql.startsWith('SELECT * FROM')) {
        return [
          [['p@ssw0rd-REAL']],
          [{ name: 'password', orgName: 'password', type: 253, flags: 0 }],
        ];
      }
      return [[], []];
    });

    const result = await getTableData('p1', 'shop', 'users', {});
    expect(result.rows[0][0]).toBe('••••••••');
    expect(result.unlocked).toBe(false);
  });

  it('reveals table rows once writes are unlocked', async () => {
    resetState();
    h.unlocked = true;
    h.conn = fakeConn((sql) => {
      if (sql.includes('information_schema.COLUMNS')) {
        return [[{ COLUMN_NAME: 'password' }], []];
      }
      if (sql.startsWith('SELECT * FROM')) {
        return [
          [['p@ssw0rd-REAL']],
          [{ name: 'password', orgName: 'password', type: 253, flags: 0 }],
        ];
      }
      return [[], []];
    });

    const result = await getTableData('p1', 'shop', 'users', { revealSensitive: true });
    expect(result.rows[0][0]).toBe('p@ssw0rd-REAL');
    expect(result.unlocked).toBe(true);
  });

  it('rejects revealSensitive in the explorer route while writes are locked', async () => {
    resetState();
    const router = explorerRouter as unknown as {
      stack: { route?: { path: string; stack: { handle: unknown }[] } }[];
    };
    const layer = router.stack.find(
      (entry) => entry.route?.path === '/:profileId/databases/:database/tables/:table/data',
    );
    const handler = layer?.route?.stack[0]?.handle as (
      req: unknown,
      res: unknown,
      next: (error?: unknown) => void,
    ) => void;
    expect(handler).toBeTypeOf('function');

    const errors: unknown[] = [];
    handler(
      {
        params: { profileId: 'p1', database: 'shop', table: 'users' },
        body: { revealSensitive: true },
        user: { id: 'u1', username: 'admin', role: 'admin' },
      },
      { json: () => undefined },
      (error?: unknown) => {
        errors.push(error);
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors[0]).toMatchObject({ code: 'REVEAL_LOCKED' });
    expect(h.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* D-12 / D-16 — sandbox copy                                          */
/* ------------------------------------------------------------------ */

function provisionConn(insertRows: number[]): { threadId: number; query: unknown } {
  let insertIndex = 0;
  let keyIndex = 0;
  const keys = [1000, 2000];
  return fakeConn((sql) => {
    if (sql.includes('information_schema.SCHEMATA') && sql.includes('SCHEMA_NAME AS name')) {
      return [[{ name: 'shop' }], []];
    }
    if (sql.includes('DEFAULT_CHARACTER_SET_NAME')) {
      return [[{ charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }], []];
    }
    if (sql.includes('information_schema.TABLES')) {
      // The estimate is deliberately wrong: rowsCopied must not use it.
      return [[{ name: 'orders', row_count: 999_999 }], []];
    }
    if (sql.includes("INDEX_NAME = 'PRIMARY'")) {
      return [[{ column_name: 'id', data_type: 'int' }], []];
    }
    if (sql.startsWith('CREATE DATABASE')) {
      return [{ affectedRows: 0 }, []];
    }
    if (sql.startsWith('CREATE TABLE')) {
      return [{ affectedRows: 0 }, []];
    }
    if (sql.startsWith('INSERT INTO')) {
      const affected = insertRows[Math.min(insertIndex, insertRows.length - 1)];
      insertIndex += 1;
      return [{ affectedRows: affected }, []];
    }
    if (sql.includes(' AS k FROM')) {
      const value = keys[keyIndex];
      keyIndex += 1;
      return [value === undefined ? [] : [{ k: value }], []];
    }
    return [[], []];
  });
}

describe('D-12 — the sandbox copy runs under a server-side timeout', () => {
  it('applies the query guards around the copy loop', async () => {
    resetState();
    h.conn = provisionConn([1000, 1000, 500]);

    await provisionSandbox('p1', 'shop', 'shop_1', true);

    expect(h.guardCalls.length).toBeGreaterThan(0);
    const guard = h.guardCalls[0];
    expect(guard.queryTimeoutMs).toBeGreaterThan(0);
    // A copy must not be capped by the server-side row limit.
    expect(guard.includeRowLimit).toBe(false);
    expect(guard.isReadOnly).toBe(false);
  });

  it('copies in batches instead of one unbounded statement', async () => {
    resetState();
    h.conn = provisionConn([1000, 1000, 500]);

    await provisionSandbox('p1', 'shop', 'shop_1', true);

    const inserts = h.calls.filter((call) => call.sql.startsWith('INSERT INTO'));
    expect(inserts.length).toBe(3);
    for (const insert of inserts) {
      // Every batch copies a closed key range, so no row is skipped or repeated.
      expect(insert.sql).toContain('`id`');
      expect(insert.sql).toMatch(/WHERE `id`/);
      // Every copy statement carries its own deadline.
      expect(insert.timeout).toBeGreaterThan(0);
    }
    // The batch boundary is read with a bounded scan.
    const boundaries = h.calls.filter((call) => call.sql.includes('AS k FROM'));
    expect(boundaries.length).toBe(3);
    expect(boundaries[0].sql).toContain('LIMIT 1 OFFSET ?');
  });
});

describe('D-16 — rowsCopied counts the rows that were copied', () => {
  it('uses the affected rows of the copy, not the information_schema estimate', async () => {
    resetState();
    h.conn = provisionConn([1000, 1000, 500]);

    const result = await provisionSandbox('p1', 'shop', 'shop_1', true);

    expect(result.rowsCopied).toBe(2500);
    expect(result.rowsCopied).not.toBe(999_999);
    expect(result.complete).toBe(true);
    expect(result.dataErrors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* D-13 — MySQL bounds non-SELECT statements                          */
/* ------------------------------------------------------------------ */

describe('D-13 — non-SELECT statements are bounded on MySQL', () => {
  it('picks a timeout strategy per server flavour', () => {
    expect(resolveStatementTimeoutMode('mariadb', false)).toBe('session-all');
    expect(resolveStatementTimeoutMode('mariadb', true)).toBe('session-all');
    expect(resolveStatementTimeoutMode('mysql', true)).toBe('session-select');
    expect(resolveStatementTimeoutMode('mysql', false)).toBe('watchdog');
  });

  it('kills a statement that overruns its deadline', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(async () => [{}, []]);
      const release = vi.fn();
      const pool = {
        getConnection: async () => ({ query, release }),
      } as unknown as Pool;

      const watchdog = startStatementWatchdog({ pool, threadId: 99, timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(query).toHaveBeenCalledWith('KILL QUERY ?', [99]);
      expect(release).toHaveBeenCalled();
      watchdog.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not kill a statement that finished in time', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(async () => [{}, []]);
      const pool = {
        getConnection: async () => ({ query, release: vi.fn() }),
      } as unknown as Pool;

      const watchdog = startStatementWatchdog({ pool, threadId: 99, timeoutMs: 5_000 });
      watchdog.cancel();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(query).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ */
/* D-15 — GRANT text escapes backticks                                 */
/* ------------------------------------------------------------------ */

describe('D-15 — generated GRANT text escapes backticks', () => {
  it('doubles a backtick inside a schema or table name', () => {
    expect(
      formatGrantStatement({
        privilegeType: 'SELECT',
        schema: 'we`ird',
        table: 'ta`ble',
      }),
    ).toBe('GRANT SELECT ON `we``ird`.`ta``ble`');
  });

  it('quotes schema and table names', () => {
    expect(formatGrantStatement({ privilegeType: 'SELECT', schema: 'shop' })).toBe(
      'GRANT SELECT ON `shop`.*',
    );
    expect(formatGrantStatement({ privilegeType: 'UPDATE', schema: 'shop', table: 'orders' })).toBe(
      'GRANT UPDATE ON `shop`.`orders`',
    );
    expect(formatGrantStatement({ privilegeType: 'SELECT', grantOption: true })).toBe(
      'GRANT SELECT ON *.* WITH GRANT OPTION',
    );
  });
});

/* ------------------------------------------------------------------ */
/* D-18 — history must not keep secret literals                        */
/* ------------------------------------------------------------------ */

describe('D-18 — the history file keeps no secret literals', () => {
  it('redacts literals from a statement', () => {
    const redacted = redactStatementLiterals(
      "INSERT INTO users (password) VALUES ('p@ssw0rd-REAL')",
    );
    expect(redacted).not.toContain('p@ssw0rd-REAL');
    expect(redacted).toContain('VALUES (?)');
  });

  it('keeps escaped quotes inside the literal', () => {
    const redacted = redactStatementLiterals("SELECT * FROM t WHERE note = 'it\\'s here'");
    expect(redacted).not.toContain('here');
    expect(redacted).toContain('= ?');
  });

  it('persists the redacted statement', async () => {
    resetState();
    h.conn = fakeConn((sql) => {
      if (sql.startsWith('USE ')) return [[], []];
      if (sql.includes('password')) {
        return [
          [['p@ssw0rd-REAL']],
          [{ name: 'password', orgName: 'password', type: 253, flags: 0 }],
        ];
      }
      return [[[1]], [{ name: 'id', orgName: 'id', type: 3, flags: 0 }]];
    });

    const { executeQuery } = await import('../server/db/query');
    await executeQuery('p1', "SELECT id FROM users WHERE password = 'p@ssw0rd-REAL'");

    expect(h.history).toHaveLength(1);
    expect(h.history[0].sql).not.toContain('p@ssw0rd-REAL');
    expect(h.history[0].sql).toContain('= ?');
  });
});

/* ------------------------------------------------------------------ */
/* D-19 — truncated must mean "there is more"                          */
/* ------------------------------------------------------------------ */

describe('D-19 — a result is only truncated when an extra row exists', () => {
  it('does not mark an exactly sized result as truncated', async () => {
    resetState();
    h.conn = fakeConn((sql) => {
      if (sql.startsWith('USE ')) return [[], []];
      return [[[1], [2], [3]], [{ name: 'id', orgName: 'id', type: 3, flags: 0 }]];
    });

    const { executeQuery } = await import('../server/db/query');
    const result = await executeQuery('p1', 'SELECT id FROM users', { rowLimit: 3 });

    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(false);
    // The server-side cap is one row above the requested limit, so the extra
    // row can be observed.
    expect(h.guardCalls[0].rowLimit).toBe(4);
  });

  it('marks the result as truncated when an extra row exists', async () => {
    resetState();
    h.conn = fakeConn((sql) => {
      if (sql.startsWith('USE ')) return [[], []];
      return [[[1], [2], [3], [4]], [{ name: 'id', orgName: 'id', type: 3, flags: 0 }]];
    });

    const { executeQuery } = await import('../server/db/query');
    const result = await executeQuery('p1', 'SELECT id FROM users', { rowLimit: 3 });

    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* H-1 — the query path must mask a secret read through a sub-query     */
/* ------------------------------------------------------------------ */

const PHONE = '(503) 555-9831';

function secretConn(): { threadId: number; query: unknown } {
  return fakeConn((sql) => {
    if (sql.startsWith('USE ')) return [[], []];
    // MySQL does not propagate `org_name` through a derived table, so the
    // alias is the only name the result carries.
    return [[[PHONE]], [{ name: 'x', orgName: '', type: 253, flags: 0 }]];
  });
}

describe('H-1 — a secret read through a sub-query is masked on the query path', () => {
  it('masks a column read through a derived table', async () => {
    resetState();
    h.conn = secretConn();

    const { executeQuery } = await import('../server/db/query');
    const result = await executeQuery('p1', 'SELECT x FROM (SELECT Phone AS x FROM Shippers) d');

    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a column read through a CTE', async () => {
    resetState();
    h.conn = secretConn();

    const { executeQuery } = await import('../server/db/query');
    const result = await executeQuery(
      'p1',
      'WITH cte AS (SELECT Phone AS x FROM Shippers) SELECT x FROM cte',
    );

    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a star over a derived table', async () => {
    resetState();
    h.conn = secretConn();

    const { executeQuery } = await import('../server/db/query');
    const result = await executeQuery('p1', 'SELECT * FROM (SELECT Phone AS x FROM Shippers) d');

    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a UNION whose second branch carries the secret', async () => {
    resetState();
    h.conn = secretConn();

    const { executeQuery } = await import('../server/db/query');
    const result = await executeQuery(
      'p1',
      "SELECT 'redacted' AS x UNION SELECT Phone AS x FROM Shippers",
    );

    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('does not mask a result column that reads an ordinary column', async () => {
    resetState();
    h.conn = fakeConn((sql) => {
      if (sql.startsWith('USE ')) return [[], []];
      return [[['Speedy Express']], [{ name: 'x', orgName: '', type: 253, flags: 0 }]];
    });

    const { executeQuery } = await import('../server/db/query');
    const result = await executeQuery(
      'p1',
      'SELECT x FROM (SELECT ShipperName AS x FROM Shippers) d',
    );

    expect(result.rows[0][0]).toBe('Speedy Express');
  });
});
