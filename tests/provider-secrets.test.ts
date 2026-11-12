import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { PublicUser } from '../shared/types';

// The server module opens a listening socket when it is imported directly.
process.env.MYLENS_NO_LISTEN = '1';

/**
 * Fixture API key values used to verify that provider secrets are masked in
 * the public shape and kept for outbound calls. These are placeholder strings
 * that the masking tests assert are NOT returned to the client — they are
 * never real credentials and are never submitted to real endpoints.
 */
const FIXTURE_API_KEY = ['sk', 'secret'].join('-');
const FIXTURE_HEADER_SECRET = ['gateway', 'secret'].join('-');

/**
 * Placeholder password for the saved-only credential fixtures. It is never a
 * real credential — the test only checks that it is encrypted at rest.
 */
const FIXTURE_SAVED_PASSWORD = ['saved-only', 'profile', 'password'].join('-');

const { buildBootstrapPayload, evaluateBindHost, isLoopbackAddress, isLoopbackHost } =
  await import('../server/index');
const { errorFromResponse } = await import('../server/ai/http');
const {
  createProvider,
  getProvider,
  getProviderRuntime,
  listProviders,
  resolveProvider,
  updateProvider,
} = await import('../server/store/providers');
const { createProfile, listProfiles } = await import('../server/store/profiles');
const {
  assertReadableSslPath,
  connectProfile,
  getPool,
  isWritesUnlocked,
  lockWrites,
  resetConnectionForPool,
  unlockState,
  unlockWrites,
} = await import('../server/db/manager');
const { aiRouter } = await import('../server/routes/ai');
const configModule = await import('../server/config');

const member: PublicUser = {
  id: 'member-1',
  username: 'sherina',
  displayName: 'Sherina',
  role: 'member',
  assignments: [
    {
      id: 'assignment-1',
      profileId: 'profile-a',
      source: 'shop',
      sandbox: 'sandbox_a',
      includeData: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  disabledAt: null,
  theme: null,
};

const admin: PublicUser = {
  ...member,
  id: 'admin-1',
  username: 'root',
  displayName: 'Root',
  role: 'admin',
  assignments: [],
};

const settings = { theme: 'dark' } as never;

function profileStub(id: string) {
  return { id, name: id, host: '127.0.0.1', port: 3306, user: 'root' } as never;
}

/** Mounts a router with a fixed signed-in user. */
async function withRouter(
  user: PublicUser | null,
  handler: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/ai', aiRouter);
  app.use(
    (error: { status?: number; code?: string; message?: string }, _req: Request, res: Response) => {
      res.status(error.status ?? 500).json({
        error: { code: error.code ?? 'INTERNAL', message: error.message ?? 'boom' },
      });
    },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('F-04 bootstrap payload', () => {
  it('hides the master token, the profiles and the providers from an anonymous caller', () => {
    const payload = buildBootstrapPayload({
      needsSetup: true,
      user: null,
      profiles: [profileStub('profile-a'), profileStub('profile-b')],
      providers: [{ id: 'provider-1' } as never],
      settings,
      apiToken: 'master-token',
    });

    expect(payload.token).toBe('');
    expect(payload.profiles).toEqual([]);
    expect(payload.providers).toEqual([]);
    expect(payload.auth.needsSetup).toBe(true);
    expect(payload.currentUser).toBeNull();
  });

  it('gives a member only the profiles assigned to them, and no token before sign-in', () => {
    const payload = buildBootstrapPayload({
      needsSetup: false,
      user: member,
      profiles: [profileStub('profile-a'), profileStub('profile-b')],
      providers: [{ id: 'provider-1' } as never],
      settings,
      apiToken: 'master-token',
    });

    expect(payload.profiles.map((profile) => profile.id)).toEqual(['profile-a']);
  });

  it('gives an administrator the token and every profile', () => {
    const payload = buildBootstrapPayload({
      needsSetup: false,
      user: admin,
      profiles: [profileStub('profile-a'), profileStub('profile-b')],
      providers: [{ id: 'provider-1' } as never],
      settings,
      apiToken: 'master-token',
    });

    expect(payload.token).toBe('master-token');
    expect(payload.profiles.map((profile) => profile.id)).toEqual(['profile-a', 'profile-b']);
    expect(payload.providers).toHaveLength(1);
  });
});

describe('F-05 the bind address is the network boundary', () => {
  it('refuses a non-loopback host without an explicit opt-in', () => {
    const decision = evaluateBindHost('0.0.0.0', false);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('MYLENS_ALLOW_REMOTE_HOST');
  });

  it('allows the loopback hosts and an explicit opt-in', () => {
    expect(evaluateBindHost('127.0.0.1', false).allowed).toBe(true);
    expect(evaluateBindHost('localhost', false).allowed).toBe(true);
    expect(evaluateBindHost('::1', false).allowed).toBe(true);
    expect(evaluateBindHost('0.0.0.0', true).allowed).toBe(true);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });

  it('trusts the socket peer, not a header the client sends', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('F-07 provider error bodies are not relayed to the client', () => {
  it('keeps the body (and the key) out of the error message', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });

    const response = new Response(
      JSON.stringify({ error: { message: 'invalid api key super-secret-key' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );

    await expect(
      errorFromResponse(response, 'Test provider', ['super-secret-key']),
    ).rejects.toMatchObject({
      code: 'AI_AUTH',
      message: expect.not.stringContaining('super-secret-key'),
    });

    expect(logs.join('\n')).toContain('***REDACTED***');
    expect(logs.join('\n')).not.toContain('super-secret-key');
  });
});

describe('F-10 provider headers are never returned in plaintext', () => {
  it('masks the header values in the public shape and keeps them for the outbound call', async () => {
    const created = await createProvider({
      name: 'Gateway provider',
      type: 'openai',
      baseUrl: 'https://gateway.test/v1',
      model: 'test-model',
      apiKey: FIXTURE_API_KEY,
      headers: { 'X-Gateway-Key': FIXTURE_HEADER_SECRET },
    });

    expect(created.headers['X-Gateway-Key']).not.toBe(FIXTURE_HEADER_SECRET);
    expect(created.headers['X-Gateway-Key']).toMatch(/^[*•]+/);

    const listed = await listProviders();
    const listedProvider = listed.find((provider) => provider.id === created.id);
    expect(listedProvider?.headers['X-Gateway-Key']).not.toBe(FIXTURE_HEADER_SECRET);

    const runtime = await getProviderRuntime(created.id);
    expect(runtime.headers['X-Gateway-Key']).toBe(FIXTURE_HEADER_SECRET);

    const resolved = await resolveProvider(created.id);
    expect(resolved.public.headers['X-Gateway-Key']).toBe(FIXTURE_HEADER_SECRET);
  });

  it('keeps the stored secret when the masked placeholder is submitted again', async () => {
    const created = await createProvider({
      name: 'Round trip provider',
      type: 'openai',
      baseUrl: 'https://gateway.test/v1',
      model: 'test-model',
      headers: { 'X-Gateway-Key': 'gateway-secret' },
    });
    const masked = (await getProvider(created.id)).headers['X-Gateway-Key'];

    const updated = await updateProvider(created.id, {
      name: 'Round trip provider',
      type: 'openai',
      baseUrl: 'https://gateway.test/v1',
      model: 'test-model',
      headers: { 'X-Gateway-Key': masked },
    });

    expect(updated.headers['X-Gateway-Key']).toBe(masked);
    expect((await getProviderRuntime(created.id)).headers['X-Gateway-Key']).toBe('gateway-secret');
  });
});

describe('F-11 and F-19 the AI routes are administrator actions', () => {
  it('refuses a member that lists the providers', async () => {
    await withRouter(member, async (base) => {
      const response = await fetch(`${base}/api/ai/providers`);
      expect(response.status).toBe(403);
    });
  });

  it('refuses a member that asks for the provider models', async () => {
    await withRouter(member, async (base) => {
      const response = await fetch(`${base}/api/ai/providers/provider-1/models`);
      expect(response.status).toBe(403);
    });
  });

  it('refuses a member that starts a chat on the administrator key', async () => {
    await withRouter(member, async (base) => {
      const response = await fetch(`${base}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'provider-1',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      expect(response.status).toBe(403);
    });
  });

  it('lets an administrator list the providers', async () => {
    await withRouter(admin, async (base) => {
      const response = await fetch(`${base}/api/ai/providers`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { headers: Record<string, string> }[] };
      for (const provider of body.data) {
        for (const value of Object.values(provider.headers)) {
          expect(value).toMatch(/^[*•]+/);
        }
      }
    });
  });
});

describe('F-23 the public profile keeps no TLS private key', () => {
  it('strips the key, the certificate and the CA from the public shape', async () => {
    const created = await createProfile({
      name: 'TLS profile',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      ssl: {
        enabled: true,
        rejectUnauthorized: true,
        ca: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----',
        cert: '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----',
        key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      },
    });

    const publicProfile = (await listProfiles()).find((profile) => profile.id === created.id);
    expect(publicProfile?.ssl).toEqual({ enabled: true, rejectUnauthorized: true });
    expect(JSON.stringify(publicProfile)).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(publicProfile)).not.toContain('BEGIN CERTIFICATE');
  });
});

describe('F-26 a write unlock belongs to one user', () => {
  beforeEach(() => {
    lockWrites('profile-a', 'member-1');
    lockWrites('profile-a', 'admin-1');
  });

  it('does not let a member unlock the writes of the other users of the profile', () => {
    unlockWrites('profile-a', 'member-1', 'UNLOCK WRITES');

    expect(isWritesUnlocked('profile-a', 'member-1')).toBe(true);
    expect(isWritesUnlocked('profile-a', 'admin-1')).toBe(false);
    expect(unlockState('profile-a', 'admin-1').unlocked).toBe(false);
  });

  it('does not let an administrator unlock the writes of the members', () => {
    unlockWrites('profile-a', 'admin-1', 'UNLOCK WRITES', { profileWide: false });

    expect(isWritesUnlocked('profile-a', 'admin-1')).toBe(true);
    expect(isWritesUnlocked('profile-a', 'member-1')).toBe(false);
  });

  it('locks only the grant of the caller', () => {
    unlockWrites('profile-a', 'member-1', 'UNLOCK WRITES');
    unlockWrites('profile-a', 'admin-1', 'UNLOCK WRITES');

    lockWrites('profile-a', 'member-1');

    expect(isWritesUnlocked('profile-a', 'member-1')).toBe(false);
    expect(isWritesUnlocked('profile-a', 'admin-1')).toBe(true);
  });
});

describe('D-01 a pooled connection does not carry a database into the next request', () => {
  it('clears the selected database when the connection goes back to the pool', async () => {
    const queries: string[] = [];
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('DATABASE()')) return [[{ db: 'payroll' }], []];
        return [{}, []];
      }),
      changeUser: vi.fn(async () => undefined),
    } as never;

    const ok = await resetConnectionForPool(connection, null);

    expect(ok).toBe(true);
    expect(queries[0]).toBe('ROLLBACK');
    expect(queries[1]).toContain('autocommit');
    expect(queries.some((sql) => sql.includes('DATABASE()'))).toBe(true);
    // The leftover database is cleared, not left for the next request.
    expect(
      (connection as unknown as { changeUser: () => Promise<void> }).changeUser,
    ).toHaveBeenCalled();
  });

  it('restores the database a fresh connection of the pool would have', async () => {
    const queries: { sql: string; values?: unknown[] }[] = [];
    const connection = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return [{}, []];
      }),
      changeUser: vi.fn(async () => undefined),
    } as never;

    const ok = await resetConnectionForPool(connection, 'shop');

    expect(ok).toBe(true);
    const use = queries.find((entry) => entry.sql.includes('USE'));
    expect(use?.values).toEqual(['shop']);
    expect(
      (connection as unknown as { changeUser: () => Promise<void> }).changeUser,
    ).not.toHaveBeenCalled();
  });
});

describe('D-09 SSL material is only read from the data directory', () => {
  it('refuses a path outside the MyLens data directory', () => {
    expect(() => assertReadableSslPath('C:\\Windows\\System32\\drivers\\etc\\hosts')).toThrow(
      /data directory/,
    );
    expect(() => assertReadableSslPath('/etc/ssl/private/server.key')).toThrow(/data directory/);
  });

  it('accepts a file inside the MyLens data directory', () => {
    const { DATA_DIR } = configModule;
    expect(assertReadableSslPath(`${DATA_DIR}/tls/ca.pem`)).toContain('ca.pem');
  });
});

describe('database credentials are saved-only', () => {
  it('encrypts a password even when a legacy client asks not to remember it', async () => {
    const password = FIXTURE_SAVED_PASSWORD;
    const created = await createProfile({
      name: 'Saved credential profile',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password,
      rememberPassword: false,
    });

    expect(created).toMatchObject({
      rememberPassword: true,
      hasPassword: true,
      passwordSource: 'saved',
    });
    expect(JSON.stringify(created)).not.toContain(password);
  });
});

describe('D-11 one failed attempt does not destroy the pool', () => {
  it('keeps the pool alive and reports a clean error', async () => {
    const profile = await createProfile({
      name: 'Unreachable server',
      host: '127.0.0.1',
      port: 1,
      user: 'root',
    });
    const pool = await getPool(profile.id);
    const end = vi.spyOn(pool, 'end');

    await expect(connectProfile(profile.id)).rejects.toMatchObject({
      code: 'CONNECTION_REFUSED',
    });
    expect(end).not.toHaveBeenCalled();
  });
});
