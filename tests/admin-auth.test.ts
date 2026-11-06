import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  createUser,
  findUserById,
  hashPassword,
  setUserTheme,
  verifyPassword,
} from '../server/store/users';
import { parseSessionCookie, SESSION_COOKIE } from '../server/store/sessions';
import { sandboxScopeOverride } from '../server/auth';
import { AppError } from '../server/errors';
import { adminRouter } from '../server/routes/admin';
import { authRouter, resetLoginThrottle } from '../server/routes/auth';
import type { PublicUser, SandboxAssignment } from '../shared/types';

function userWith(role: 'admin' | 'member', assignments: SandboxAssignment[]): PublicUser {
  return {
    id: 'u1',
    username: 'tester',
    displayName: 'Tester',
    role,
    assignments,
    createdAt: '2026-01-01T00:00:00Z',
    disabledAt: null,
  };
}

function assignment(sandbox: string, profileId = 'p1'): SandboxAssignment {
  return {
    id: `a-${sandbox}`,
    profileId,
    source: 'northwind',
    sandbox,
    includeData: true,
    createdAt: '2026-01-01T00:00:00Z',
    lastResetAt: null,
  };
}

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', () => {
    const hash = hashPassword('review123');
    expect(verifyPassword('review123', hash)).toBe(true);
    expect(verifyPassword('review124', hash)).toBe(false);
  });

  it('salts every hash so equal passwords never match hashes', () => {
    expect(hashPassword('review123')).not.toBe(hashPassword('review123'));
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$zz$yy')).toBe(false);
  });
});

describe('session cookie parsing', () => {
  it('reads the MyLens session cookie from a header', () => {
    const header = `${SESSION_COOKIE}=abc123; other=1`;
    expect(parseSessionCookie(header)).toBe('abc123');
  });

  it('returns null when the cookie is missing', () => {
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie('other=1')).toBeNull();
    expect(parseSessionCookie(`${SESSION_COOKIE}=`)).toBe('');
  });

  it('decodes URL-encoded session ids', () => {
    expect(parseSessionCookie(`${SESSION_COOKIE}=a%2Fb`)).toBe('a/b');
  });
});

describe('personal theme persistence', () => {
  it('stores the preference on the account without exposing password material', async () => {
    const password = `theme-${randomUUID()}`;
    const created = await createUser({
      username: `theme-${randomUUID().slice(0, 8)}`,
      displayName: 'Theme Member',
      password,
      role: 'member',
    });
    expect(created.theme).toBeNull();

    const saved = await setUserTheme(created.id, 'light');
    expect(saved?.theme).toBe('light');

    const reread = await findUserById(created.id);
    expect(reread?.theme).toBe('light');
    expect((reread as unknown as Record<string, unknown>).passwordHash).toMatch(/^scrypt\$/);
  });
});

describe('sandbox scope override', () => {
  it('gives admins the profile scope (no override)', () => {
    expect(sandboxScopeOverride(userWith('admin', []), 'p1')).toBeUndefined();
  });

  it('narrows members to the sandboxes of that profile', () => {
    const user = userWith('member', [assignment('northwind_1'), assignment('northwind_2', 'p2')]);
    expect(sandboxScopeOverride(user, 'p1')).toEqual({ allowed: ['northwind_1'] });
  });

  it('fails closed for unknown users and unassigned profiles', () => {
    expect(sandboxScopeOverride(undefined, 'p1')).toEqual({ allowed: [] });
    expect(sandboxScopeOverride(userWith('member', []), 'p1')).toEqual({ allowed: [] });
    expect(sandboxScopeOverride(userWith('member', [assignment('northwind_1')]), 'other')).toEqual({
      allowed: [],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP harness                                                                */
/* -------------------------------------------------------------------------- */

const signedInAdmin: PublicUser = {
  id: 'admin-1',
  username: 'harness-admin',
  displayName: 'Harness Admin',
  role: 'admin',
  assignments: [],
  createdAt: '2026-01-01T00:00:00Z',
  disabledAt: null,
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use((req, _res, next) => {
    // The sign-in routes are reachable without a session; every other route
    // needs one, which the harness provides.
    if (!req.path.startsWith('/api/auth')) req.user = signedInAdmin;
    next();
  });
  app.use('/api/admin', adminRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error.' } });
  });
  return app;
}

async function postJson(
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: { error?: { code?: string; message?: string } } }> {
  const app = buildApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as never };
  } finally {
    server.close();
  }
}

describe('F-24 — an invalid request body is a validation error, not a server error', () => {
  it('answers the pre-session sign-in route with 400', async () => {
    const response = await postJson('/api/auth/login', { username: 'x' });

    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('VALIDATION');
  });

  it('answers the admin account route with 400', async () => {
    const response = await postJson('/api/admin/users', { username: 'only-a-name' });

    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('VALIDATION');
  });
});

describe('F-25 — a duplicate username is a conflict', () => {
  it('answers the admin account route with 409', async () => {
    const username = `dup-${randomUUID().slice(0, 8)}`;
    const created = await postJson('/api/admin/users', {
      username,
      displayName: 'First',
      password: 'review123',
      role: 'member',
    });
    expect(created.status).toBe(200);

    const duplicate = await postJson('/api/admin/users', {
      username,
      displayName: 'Second',
      password: 'review123',
      role: 'member',
    });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.code).toBe('USERNAME_TAKEN');
  });
});

describe('F-27 — the sign-in route is rate limited', () => {
  it('locks the account out after too many failed attempts', async () => {
    resetLoginThrottle();
    const username = `rl-${randomUUID().slice(0, 8)}`;
    await createUser({
      username,
      displayName: 'Rate Limited',
      password: 'review123',
      role: 'member',
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postJson('/api/auth/login', { username, password: 'wrong-password' });
      expect(response.status).toBe(401);
    }

    const blocked = await postJson('/api/auth/login', { username, password: 'wrong-password' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error?.code).toBe('TOO_MANY_ATTEMPTS');

    // The correct password is refused as well while the lock is active.
    const correct = await postJson('/api/auth/login', { username, password: 'review123' });
    expect(correct.status).toBe(429);

    resetLoginThrottle();
  });
});
