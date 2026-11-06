import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { describe, expect, it } from 'vitest';

import { resolveSessionUser } from '../server/auth';
import { runAiChat, runAiReview } from '../server/ai/analyze';
import { runExplain } from '../server/db/explain';
import { assertSqlScope, collectReferencedDatabases } from '../server/db/scope';
import { AppError } from '../server/errors';
import { practiceRouter } from '../server/routes/practice';
import { queryRouter } from '../server/routes/query';
import { reviewRouter } from '../server/routes/review';
import { createProfile } from '../server/store/profiles';
import { createSession, SESSION_COOKIE } from '../server/store/sessions';
import { createUser, setAssignments } from '../server/store/users';
import type { AiProvider, SandboxAssignment } from '../shared/types';

/** The single sandbox database the member is allowed to touch. */
const SANDBOX = 'northwind_1';
/** A database the member must never reach. */
const FOREIGN = 'checkit_db';

function assignment(profileId: string): SandboxAssignment {
  return {
    id: `a-${profileId}`,
    profileId,
    source: 'northwind',
    sandbox: SANDBOX,
    includeData: true,
    createdAt: '2026-01-01T00:00:00Z',
    lastResetAt: null,
  };
}

/** A member account with a session cookie and assignments for the given profiles. */
async function memberSession(profileIds: string[]): Promise<{ cookie: string }> {
  const user = await createUser({
    username: `scope-${randomUUID().slice(0, 8)}`,
    displayName: 'Scope Member',
    password: 'review123',
    role: 'member',
  });
  await setAssignments(
    user.id,
    profileIds.map((profileId) => assignment(profileId)),
  );
  const session = await createSession(user.id);
  return { cookie: `${SESSION_COOKIE}=${session.id}` };
}

/** A profile whose own scope is unrestricted, like the connections admins create. */
async function openProfile(name: string): Promise<{ id: string }> {
  return createProfile({
    name,
    host: '127.0.0.1',
    port: 3399,
    user: 'root',
    databaseScope: 'all',
  });
}

/** Mount a router on a throwaway server and return its base URL. */
async function startApp(
  router: Router,
  mountPath: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(resolveSessionUser);
  app.use(mountPath, router);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({
      error: { code: 'INTERNAL', message: String((err as Error)?.message ?? err) },
    });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const provider: AiProvider = {
  id: 'provider-1',
  name: 'Test provider',
  type: 'openai',
  baseUrl: 'http://127.0.0.1:9/v1',
  chatPath: '/chat/completions',
  modelsPath: '/models',
  model: 'test-model',
  models: ['test-model'],
  hasApiKey: true,
  apiKeyHint: null,
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  headers: {},
  extraBody: {},
  temperature: 0,
  maxTokens: 100,
  streaming: false,
  isDefault: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('D-02 / F-01: the EXPLAIN path applies the member scope', () => {
  it('refuses to explain a statement that references a foreign database', async () => {
    const profile = await openProfile('Explain scope');
    await expect(
      runExplain(profile.id, `SELECT * FROM ${FOREIGN}.attendances`, null, {
        scopeOverride: { allowed: [SANDBOX] },
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_NOT_ALLOWED', status: 403 });
  });

  it('applies the member scope on the /explain route', async () => {
    const profile = await openProfile('Explain route scope');
    const { cookie } = await memberSession([profile.id]);
    const app = await startApp(queryRouter, '/api/db');
    try {
      const response = await fetch(`${app.url}/api/db/${profile.id}/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ sql: `SELECT * FROM ${FOREIGN}.attendances` }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('DATABASE_NOT_ALLOWED');
    } finally {
      await app.close();
    }
  });
});

describe('D-03 / F-02: version comments and unparsable statements', () => {
  const override = { allowed: [SANDBOX] };

  it('rejects a version comment that hides a database reference', async () => {
    await expect(
      assertSqlScope(
        'any-profile',
        `SELECT COUNT(*) FROM /*!${FOREIGN}*/.attendances`,
        SANDBOX,
        override,
      ),
    ).rejects.toMatchObject({ code: 'EXECUTABLE_COMMENT_NOT_ALLOWED', status: 403 });
  });

  it('rejects a version comment that smuggles in a UNION', async () => {
    await expect(
      assertSqlScope(
        'any-profile',
        'SELECT 1 /*!50000 UNION SELECT password FROM hidden.payroll */',
        SANDBOX,
        override,
      ),
    ).rejects.toMatchObject({ code: 'EXECUTABLE_COMMENT_NOT_ALLOWED', status: 403 });
  });

  it('finds a database reference the parser cannot see', async () => {
    // The parser rejects this statement outright; the token scan still finds
    // the qualified name.
    expect(collectReferencedDatabases('SELECT * FROM `se`cret`.`t`').size).toBeGreaterThan(0);
    await expect(
      assertSqlScope('any-profile', 'SELECT * FROM `se`cret`.`t`', SANDBOX, override),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('allows valid SQL the parser cannot read, but still refuses what it cannot verify', async () => {
    // An index hint is ordinary SQL that node-sql-parser cannot read. The raw
    // token scan finds no database reference in it, so it is safe to allow on a
    // scoped connection - refusing it would break legitimate member work.
    await expect(
      assertSqlScope(
        'any-profile',
        'SELECT * FROM orders FORCE INDEX (idx_id) WHERE id = 1',
        SANDBOX,
        override,
      ),
    ).resolves.toBeDefined();

    // The same hint on a database outside the scope is still refused: the raw
    // scan finds the database the parser could not read.
    await expect(
      assertSqlScope(
        'any-profile',
        `SELECT * FROM ${FOREIGN}.orders FORCE INDEX (idx_id) WHERE id = 1`,
        SANDBOX,
        override,
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_NOT_ALLOWED', status: 403 });

    // A statement that hides its SQL inside a string cannot be verified at all,
    // so it is denied rather than assumed safe.
    await expect(
      assertSqlScope(
        'any-profile',
        `PREPARE s FROM 'SELECT * FROM ${FOREIGN}.orders'`,
        SANDBOX,
        override,
      ),
    ).rejects.toMatchObject({ code: 'SQL_PARSE_FAILED', status: 403 });
  });
});

describe('D-07: SHOW variants that name another database', () => {
  it('collects the database of a SHOW statement', () => {
    expect(collectReferencedDatabases(`SHOW FULL TABLES FROM ${FOREIGN}`)).toContain(FOREIGN);
    expect(collectReferencedDatabases(`SHOW TRIGGERS FROM ${FOREIGN}`)).toContain(FOREIGN);
    expect(collectReferencedDatabases(`SHOW TABLE STATUS FROM ${FOREIGN}`)).toContain(FOREIGN);
  });

  it('denies a SHOW statement that names a database outside the scope', async () => {
    await expect(
      assertSqlScope('any-profile', `SHOW FULL TABLES FROM ${FOREIGN}`, SANDBOX, {
        allowed: [SANDBOX],
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_NOT_ALLOWED', status: 403 });
  });
});

describe('D-14: the USE guard only fires on a leading USE', () => {
  it('allows a column that is called use', async () => {
    await expect(
      assertSqlScope('any-profile', 'SELECT `use` FROM t', SANDBOX, { allowed: [SANDBOX] }),
    ).resolves.toMatchObject({ mode: 'selected' });
  });

  it('still refuses a statement that switches database', async () => {
    await expect(
      assertSqlScope('any-profile', `SELECT 1; USE ${FOREIGN}`, SANDBOX, { allowed: [SANDBOX] }),
    ).rejects.toThrow(/USE is not allowed/);
  });
});

describe('F-03: the review routes authorize the profile and apply the scope', () => {
  it('refuses a static review of a profile the member is not assigned to', async () => {
    const assigned = await openProfile('Assigned profile');
    const other = await openProfile('Other profile');
    const { cookie } = await memberSession([assigned.id]);
    const app = await startApp(reviewRouter, '/api/review');
    try {
      const response = await fetch(`${app.url}/api/review/static`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ profileId: other.id, sql: 'SELECT 1' }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('PROFILE_NOT_ASSIGNED');
    } finally {
      await app.close();
    }
  });

  it('refuses a static review of a database outside the member scope', async () => {
    const profile = await openProfile('Review scope');
    const { cookie } = await memberSession([profile.id]);
    const app = await startApp(reviewRouter, '/api/review');
    try {
      const response = await fetch(`${app.url}/api/review/static`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          profileId: profile.id,
          database: FOREIGN,
          sql: 'SELECT 1',
          includeSchema: false,
        }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('DATABASE_NOT_ALLOWED');
    } finally {
      await app.close();
    }
  });
});

describe('F-06: the AI layer applies the member scope', () => {
  it('refuses an AI review of a foreign database', async () => {
    await expect(
      runAiReview(
        {
          profileId: 'profile-1',
          database: FOREIGN,
          sql: 'SELECT 1',
          providerId: provider.id,
        },
        provider,
        null,
        () => undefined,
        undefined,
        { scopeOverride: { allowed: [SANDBOX] } },
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_NOT_ALLOWED', status: 403 });
  });

  it('refuses an AI chat that reads a foreign database', async () => {
    await expect(
      runAiChat(
        {
          providerId: provider.id,
          messages: [{ role: 'user', content: 'hello' }],
          context: { profileId: 'profile-1', database: FOREIGN },
        },
        provider,
        null,
        () => undefined,
        undefined,
        { scopeOverride: { allowed: [SANDBOX] } },
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_NOT_ALLOWED', status: 403 });
  });
});

describe('F-33: the practice route validates before it authorizes', () => {
  it('answers a malformed profileId with a validation error', async () => {
    const { cookie } = await memberSession([]);
    const app = await startApp(practiceRouter, '/api/practice');
    try {
      const response = await fetch(`${app.url}/api/practice/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ profileId: 123 }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION');
    } finally {
      await app.close();
    }
  });
});
