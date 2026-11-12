import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { describe, expect, it } from 'vitest';
import type { PublicUser } from '../shared/types';
import { privateAuthenticatedResponse, rejectUnexpectedUser } from '../server/auth';
import { authRouter } from '../server/routes/auth';
import { createSession, resolveSession, sessionCookieHeader } from '../server/store/sessions';

const user: PublicUser = {
  id: 'owner-a',
  username: 'owner-a',
  displayName: 'Owner A',
  role: 'member',
  assignments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  disabledAt: null,
};

function app(onPrivate?: () => void): express.Express {
  const instance = express();
  instance.use((req, _res, next) => {
    req.user = user;
    next();
  });
  instance.get('/bootstrap', (_req, res) => res.json({ data: { ok: true } }));
  instance.use(privateAuthenticatedResponse);
  instance.use(rejectUnexpectedUser);
  instance.get('/private', (_req, res) => {
    onPrivate?.();
    res.json({ data: { ok: true } });
  });
  instance.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    res.status(500).json({ error: { message: String(error) } });
  });
  return instance;
}

async function request(path: string, expected?: string, onPrivate?: () => void): Promise<Response> {
  const server = app(onPrivate).listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: expected ? { 'x-mylens-expected-user-id': expected } : {},
    });
  } finally {
    server.close();
  }
}

describe('authenticated API response and stale-tab middleware', () => {
  it('accepts only the matching expected owner', async () => {
    expect((await request('/private', user.id)).status).toBe(200);
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'owner-b'],
  ])('rejects a %s expected owner before the route side effect', async (_label, expected) => {
    let sideEffects = 0;
    const response = await request('/private', expected, () => {
      sideEffects += 1;
    });
    expect(response.status).toBe(409);
    expect(sideEffects).toBe(0);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'EXPECTED_USER_MISMATCH',
        message:
          'The expected signed-in user is missing or no longer matches this session. Reload the app.',
      },
    });
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'previous-owner'],
  ])('%s-owner logout cannot delete the current account session', async (_label, expected) => {
    const currentSession = await createSession(user.id);
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.user = user;
      next();
    });
    instance.use('/api/auth', authRouter);
    instance.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
      res.status(500).json({ error: { message: String(error) } });
    });
    const server = instance.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: sessionCookieHeader(currentSession),
          ...(expected ? { 'x-mylens-expected-user-id': expected } : {}),
        },
      });
      expect(response.status).toBe(409);
      await expect(resolveSession(currentSession.id)).resolves.not.toBeNull();
    } finally {
      server.close();
    }
  });

  it('marks authenticated JSON private and no-store', async () => {
    const response = await request('/private', user.id);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('vary')).toContain('Cookie');
  });

  it('keeps bootstrap usable by placing it before the expected-owner gate', async () => {
    const response = await request('/bootstrap', 'owner-b');
    expect(response.status).toBe(200);
  });

  it.each(['/setup', '/login', '/me'])(
    'keeps the auth discovery route %s exempt from the expected-owner gate',
    async (path) => {
      const instance = express();
      instance.use(express.json());
      instance.use((req, _res, next) => {
        req.user = user;
        next();
      });
      instance.use('/api/auth', authRouter);
      const server = instance.listen(0);
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/auth${path}`, {
          method: path === '/me' ? 'GET' : 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mylens-expected-user-id': 'stale-owner',
          },
          ...(path === '/me' ? {} : { body: JSON.stringify({ username: 'x', password: 'short' }) }),
        });
        expect(response.status).not.toBe(409);
      } finally {
        server.close();
      }
    },
  );
});
