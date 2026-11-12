import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PublicUser } from '../shared/types';
import { AppError } from '../server/errors';

const h = vi.hoisted(() => ({
  invalidateSchemaCache: vi.fn(),
}));

vi.mock('../server/db/introspection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/introspection')>();
  return { ...actual, invalidateSchemaCache: h.invalidateSchemaCache };
});

import { explorerRouter } from '../server/routes/explorer';

function user(role: 'admin' | 'member'): PublicUser {
  return {
    id: `${role}-schema-user`,
    username: role,
    displayName: role,
    role,
    assignments:
      role === 'member'
        ? [
            {
              id: 'assignment',
              profileId: 'schema-cache-profile',
              source: 'source',
              sandbox: 'sandbox',
              includeData: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              lastResetAt: null,
            },
          ]
        : [],
    createdAt: '2026-01-01T00:00:00.000Z',
    disabledAt: null,
  };
}

async function refresh(as: PublicUser, database?: string): Promise<globalThis.Response> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = as;
    next();
  });
  app.use('/api/db', explorerRouter);
  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL' } });
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}/api/db/schema-cache-profile/schema/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(database ? { database } : {}),
    });
  } finally {
    server.close();
  }
}

describe('profile-wide schema cache invalidation policy', () => {
  it('rejects members without invalidating shared cache state', async () => {
    h.invalidateSchemaCache.mockReset();
    const response = await refresh(user('member'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ADMIN_REQUIRED' } });
    expect(h.invalidateSchemaCache).not.toHaveBeenCalled();
  });

  it('allows members to invalidate only their assigned database key', async () => {
    h.invalidateSchemaCache.mockReset();
    const response = await refresh(user('member'), 'sandbox');
    expect(response.status).toBe(200);
    expect(h.invalidateSchemaCache).toHaveBeenCalledWith('schema-cache-profile', 'sandbox');
  });

  it('allows administrators to invalidate a whole profile cache', async () => {
    h.invalidateSchemaCache.mockReset();
    const response = await refresh(user('admin'));
    expect(response.status).toBe(200);
    expect(h.invalidateSchemaCache).toHaveBeenCalledWith('schema-cache-profile', undefined);
  });
});
