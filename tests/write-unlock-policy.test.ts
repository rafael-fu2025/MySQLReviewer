import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../server/errors';
import { DATA_DIR } from '../server/config';
import { invalidateProfile, isWritesUnlocked, unlockWrites } from '../server/db/manager';

/** Placeholder credential used by test fixtures — not a real password. */
const TEST_CRED = ['test', 'cred', 'fixture'].join('_');

/**
 * Placeholder body value proving a request-scoped password is refused before
 * the shared pool is touched — it is never a real credential.
 */
const FORBIDDEN_REQUEST_PASSWORD = ['request-scoped', 'override', 'is-forbidden'].join('-');
import { connectionsRouter } from '../server/routes/connections';
import { queryRouter } from '../server/routes/query';
import { adminRouter } from '../server/routes/admin';
import { createProfile, getProfile, updateProfile } from '../server/store/profiles';
import { getSettings, settingsStore, updateSettings } from '../server/store/settings';
import {
  createUser,
  findUserById,
  listUsers,
  refreshWriteUnlockMirror,
  resolveWriteUnlock,
  setAssignments,
  setWriteUnlockDisabled,
  usersStore,
  writeUnlockAllowedFor,
} from '../server/store/users';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { PublicUser, SandboxAssignment } from '../shared/types';

/* -------------------------------------------------------------------------- */
/* HTTP harness                                                                 */
/* -------------------------------------------------------------------------- */

interface JsonResponse {
  status: number;
  body: {
    data?: unknown;
    error?: { code?: string; message?: string; details?: { blocker?: string } };
  };
}

function buildApp(user: PublicUser | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // The harness plays the signed-in account; the routers read `req.user`.
    if (user) req.user = user;
    next();
  });
  app.use('/api/connections', connectionsRouter);
  app.use('/api/db', queryRouter);
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

async function call(
  user: PublicUser | null,
  method: 'GET' | 'POST' | 'PUT',
  urlPath: string,
  body?: unknown,
): Promise<JsonResponse> {
  const app = buildApp(user);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as never };
  } finally {
    server.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const profileIds: string[] = [];

/**
 * A connection that points at a port nothing listens on: the write gate has
 * to answer before any connection is attempted, so the statement never needs a
 * live MySQL server.
 */
async function makeProfile(database?: string): Promise<string> {
  const profile = await createProfile({
    name: `policy-${randomUUID().slice(0, 8)}`,
    host: '127.0.0.1',
    port: 1,
    user: 'reviewer',
    ...(database ? { database } : {}),
  });
  profileIds.push(profile.id);
  return profile.id;
}

async function makeUser(role: 'admin' | 'member', profileId: string): Promise<PublicUser> {
  const user = await createUser({
    username: `policy-${role}-${randomUUID().slice(0, 8)}`,
    displayName: `Policy ${role}`,
    password: TEST_CRED,
    role,
  });
  if (role !== 'member') return user;
  const assignment: SandboxAssignment = {
    id: `a-${randomUUID().slice(0, 8)}`,
    profileId,
    source: 'northwind',
    sandbox: 'northwind_1',
    includeData: true,
    createdAt: new Date().toISOString(),
    lastResetAt: null,
  };
  const updated = await setAssignments(user.id, [assignment]);
  if (!updated) throw new Error('Could not assign the sandbox.');
  return updated;
}

const WRITE_SQL = "UPDATE northwind_1.customers SET name = 'renamed'";

afterEach(async () => {
  // The settings and the in-memory grants are global: every test starts from
  // the default policy again.
  await updateSettings({ writeUnlockEnabled: true });
  for (const profileId of profileIds.splice(0)) {
    await invalidateProfile(profileId).catch(() => undefined);
  }
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                        */
/* -------------------------------------------------------------------------- */

describe('the global write-unlock switch', () => {
  it('refuses a write and a masked-value reveal for members when off, while admin has unrestricted write access', async () => {
    const profileId = await makeProfile('northwind_1');
    const admin = await makeUser('admin', profileId);
    const member = await makeUser('member', profileId);

    // The administrator puts the whole app into read-only mode for members.
    await updateSettings({ writeUnlockEnabled: false });

    // Members are blocked.
    const memberDecision = await resolveWriteUnlock(profileId, member.id);
    expect(memberDecision.permitted).toBe(false);
    expect(memberDecision.blocker).toBe('global');
    expect(await writeUnlockAllowedFor(profileId, member.id)).toBe(false);

    const write = await call(member, 'POST', `/api/db/${profileId}/query`, { sql: WRITE_SQL });
    expect(write.status).toBe(403);
    expect(write.body.error?.code).toBe('WRITE_LOCKED');
    expect(write.body.error?.message).toContain('every account');

    const reveal = await call(member, 'POST', `/api/db/${profileId}/query`, {
      sql: 'SELECT email FROM northwind_1.customers',
      revealSensitive: true,
    });
    expect(reveal.status).toBe(403);
    expect(reveal.body.error?.code).toBe('REVEAL_LOCKED');
    expect(reveal.body.error?.message).toContain('every account');

    // Administrators are completely unrestricted even when the global switch is off.
    const adminDecision = await resolveWriteUnlock(profileId, admin.id);
    expect(adminDecision.permitted).toBe(true);
    expect(adminDecision.allowed).toBe(true);
    expect(await writeUnlockAllowedFor(profileId, admin.id)).toBe(true);
  });

  it('keeps administrator writes free without needing an explicit unlock', async () => {
    const profileId = await makeProfile('northwind_1');
    const admin = await makeUser('admin', profileId);
    await updateSettings({ writeUnlockEnabled: true });

    const decision = await resolveWriteUnlock(profileId, admin.id);
    expect(decision.permitted).toBe(true);
    expect(decision.allowed).toBe(true);
    expect(await writeUnlockAllowedFor(profileId, admin.id)).toBe(true);

    // The write gate must not refuse the statement. It fails later, on the
    // connection, because nothing listens on the test port.
    const write = await call(admin, 'POST', `/api/db/${profileId}/query`, { sql: WRITE_SQL });
    expect(write.body.error?.code).not.toBe('WRITE_LOCKED');
    expect(write.status).not.toBe(403);
  });
});

describe('the per-account write lock', () => {
  it('locks one account out while another account on the same profile still works', async () => {
    const profileId = await makeProfile('northwind_1');
    const blocked = await makeUser('member', profileId);
    const other = await makeUser('member', profileId);
    await updateSettings({ writeUnlockEnabled: true });
    await setWriteUnlockDisabled(blocked.id, true);

    // The locked account cannot unlock.
    const unlock = await call(blocked, 'POST', `/api/connections/${profileId}/unlock`, {
      phrase: 'UNLOCK WRITES',
    });
    expect(unlock.status).toBe(403);
    expect(unlock.body.error?.code).toBe('WRITE_UNLOCK_DISABLED');
    expect(unlock.body.error?.message).toContain('your account');
    expect(isWritesUnlocked(profileId, blocked.id)).toBe(false);

    // And it cannot write.
    const write = await call(blocked, 'POST', `/api/db/${profileId}/query`, { sql: WRITE_SQL });
    expect(write.status).toBe(403);
    expect(write.body.error?.code).toBe('WRITE_LOCKED');
    expect(write.body.error?.message).toContain('your account');
    expect(await writeUnlockAllowedFor(profileId, blocked.id)).toBe(false);

    // The other account on the same profile is untouched.
    const otherUnlock = await call(other, 'POST', `/api/connections/${profileId}/unlock`, {
      phrase: 'UNLOCK WRITES',
    });
    expect(otherUnlock.status).toBe(200);
    expect(await writeUnlockAllowedFor(profileId, other.id)).toBe(true);
  });
});

describe('the per-connection write lock', () => {
  it('makes a connection read-only for members while the administrator keeps write access', async () => {
    const profileId = await makeProfile('northwind_1');
    const member = await makeUser('member', profileId);
    const admin = await makeUser('admin', profileId);
    await updateSettings({ writeUnlockEnabled: true });
    // The administrator closes write access on this connection, after it was
    // created.
    const current = await getProfile(profileId);
    await updateProfile(profileId, {
      name: current.name,
      host: current.host,
      port: current.port,
      user: current.user,
      writeAccess: 'locked',
    });

    // The member cannot unlock.
    const unlock = await call(member, 'POST', `/api/connections/${profileId}/unlock`, {
      phrase: 'UNLOCK WRITES',
    });
    expect(unlock.status).toBe(403);
    expect(unlock.body.error?.code).toBe('WRITE_UNLOCK_DISABLED');
    expect(unlock.body.error?.message).toContain('read-only');
    expect(unlock.body.error?.details?.blocker).toBe('connection');
    expect(isWritesUnlocked(profileId, member.id)).toBe(false);

    // And it cannot write.
    const write = await call(member, 'POST', `/api/db/${profileId}/query`, { sql: WRITE_SQL });
    expect(write.status).toBe(403);
    expect(write.body.error?.code).toBe('WRITE_LOCKED');
    expect(write.body.error?.message).toContain('read-only');
    expect(await writeUnlockAllowedFor(profileId, member.id)).toBe(false);

    // The administrator is not affected: an administrator always keeps full
    // write access, so the connection can still be maintained.
    const adminUnlock = await call(admin, 'POST', `/api/connections/${profileId}/unlock`, {
      phrase: 'UNLOCK WRITES',
    });
    expect(adminUnlock.status).toBe(200);
    expect(await writeUnlockAllowedFor(profileId, admin.id)).toBe(true);
  });

  it('leaves the other connections alone', async () => {
    const locked = await makeProfile('northwind_1');
    const open = await makeProfile('northwind_1');
    const member = await makeUser('member', locked);
    // The member also has the second connection, so only the write access of
    // the first one is under test.
    const openAssignment: SandboxAssignment = {
      id: `a-${randomUUID().slice(0, 8)}`,
      profileId: open,
      source: 'northwind',
      sandbox: 'northwind_1',
      includeData: true,
      createdAt: new Date().toISOString(),
      lastResetAt: null,
    };
    const updatedMember = await setAssignments(member.id, [...member.assignments, openAssignment]);
    if (!updatedMember) throw new Error('Could not assign the second connection.');
    await updateSettings({ writeUnlockEnabled: true });
    const current = await getProfile(locked);
    await updateProfile(locked, {
      name: current.name,
      host: current.host,
      port: current.port,
      user: current.user,
      writeAccess: 'locked',
    });

    // The same member may still write through the other connection.
    const unlock = await call(updatedMember, 'POST', `/api/connections/${open}/unlock`, {
      phrase: 'UNLOCK WRITES',
    });
    expect(unlock.status).toBe(200);
    expect(await writeUnlockAllowedFor(open, updatedMember.id)).toBe(true);
  });

  it('can be changed by an administrator after the connection was created', async () => {
    const profileId = await makeProfile('northwind_1');
    const admin = await makeUser('admin', profileId);
    await updateSettings({ writeUnlockEnabled: true });

    // The connection starts out open for members.
    expect((await getProfile(profileId)).writeAccess).toBe('full');

    // The administrator closes it through the ordinary connection API.
    const current = await getProfile(profileId);
    const response = await call(admin, 'PUT', `/api/connections/${profileId}`, {
      name: current.name,
      host: current.host,
      port: current.port,
      user: current.user,
      database: current.database ?? undefined,
      writeAccess: 'locked',
    });
    expect(response.status).toBe(200);
    expect((response.body.data as { writeAccess?: string } | undefined)?.writeAccess).toBe(
      'locked',
    );

    // And opens it again.
    const reopened = await call(admin, 'PUT', `/api/connections/${profileId}`, {
      name: current.name,
      host: current.host,
      port: current.port,
      user: current.user,
      database: current.database ?? undefined,
      writeAccess: 'full',
    });
    expect(reopened.status).toBe(200);
    expect((reopened.body.data as { writeAccess?: string } | undefined)?.writeAccess).toBe('full');
  });

  it('keeps the setting when an update does not mention it', async () => {
    const profileId = await makeProfile('northwind_1');
    await updateSettings({ writeUnlockEnabled: true });
    const current = await getProfile(profileId);
    await updateProfile(profileId, {
      name: current.name,
      host: current.host,
      port: current.port,
      user: current.user,
      writeAccess: 'locked',
    });

    // An update that omits the setting must not silently reopen the
    // connection.
    await updateProfile(profileId, {
      name: current.name,
      host: current.host,
      port: current.port,
      user: current.user,
    });
    expect((await getProfile(profileId)).writeAccess).toBe('locked');
  });
});

describe('member connection runtime isolation', () => {
  it.each(['admin', 'member'] as const)(
    'rejects %s password fields before touching the shared pool',
    async (role) => {
      const profileId = await makeProfile('northwind_1');
      const user = await makeUser(role, profileId);

      const response = await call(user, 'POST', `/api/connections/${profileId}/connect`, {
        password: FORBIDDEN_REQUEST_PASSWORD,
      });

      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe('VALIDATION');
    },
  );

  it('member disconnect revokes only that member grant', async () => {
    const profileId = await makeProfile('northwind_1');
    const memberA = await makeUser('member', profileId);
    const memberB = await makeUser('member', profileId);
    unlockWrites(profileId, memberA.id, 'UNLOCK WRITES');
    unlockWrites(profileId, memberB.id, 'UNLOCK WRITES');

    const response = await call(memberA, 'POST', `/api/connections/${profileId}/disconnect`);

    expect(response.status).toBe(200);
    expect(isWritesUnlocked(profileId, memberA.id)).toBe(false);
    expect(isWritesUnlocked(profileId, memberB.id)).toBe(true);
  });
});

describe('the unlock endpoint', () => {
  it('refuses with a specific error code and opens no grant for members when switch is off', async () => {
    const profileId = await makeProfile('northwind_1');
    const member = await makeUser('member', profileId);
    await updateSettings({ writeUnlockEnabled: false });

    const unlock = await call(member, 'POST', `/api/connections/${profileId}/unlock`, {
      phrase: 'UNLOCK WRITES',
    });

    expect(unlock.status).toBe(403);
    expect(unlock.body.error?.code).toBe('WRITE_UNLOCK_DISABLED');
    expect(unlock.body.error?.message).toContain('every account');
    // No grant was opened.
    expect(isWritesUnlocked(profileId, member.id)).toBe(false);
  });
});

describe('the admin API for the write switches', () => {
  it('is admin-only and validates its input', async () => {
    const profileId = await makeProfile('northwind_1');
    const admin = await makeUser('admin', profileId);
    const member = await makeUser('member', profileId);

    // A member cannot reach the admin API.
    const refused = await call(member, 'PUT', `/api/admin/users/${member.id}/write-unlock`, {
      disabled: true,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe('ADMIN_REQUIRED');

    // The body is validated.
    const invalid = await call(admin, 'PUT', `/api/admin/users/${member.id}/write-unlock`, {
      disabled: 'yes',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.code).toBe('VALIDATION');

    // An admin can set the per-account lock, and it takes effect at once.
    const applied = await call(admin, 'PUT', `/api/admin/users/${member.id}/write-unlock`, {
      disabled: true,
    });
    expect(applied.status).toBe(200);
    const decision = await resolveWriteUnlock(profileId, member.id);
    expect(decision.permitted).toBe(false);
    expect(decision.blocker).toBe('account');

    // Admin accounts cannot be locked via write-unlock API
    const adminLockRefused = await call(admin, 'PUT', `/api/admin/users/${admin.id}/write-unlock`, {
      disabled: true,
    });
    expect(adminLockRefused.status).toBe(400);
    expect(adminLockRefused.body.error?.code).toBe('ADMIN_WRITE_UNLOCK_NOT_APPLICABLE');

    // The global switch is admin-only too, and it applies to members.
    const global = await call(member, 'PUT', '/api/admin/settings/write-unlock', {
      enabled: false,
    });
    expect(global.status).toBe(403);
    expect(global.body.error?.code).toBe('ADMIN_REQUIRED');

    const globalApplied = await call(admin, 'PUT', '/api/admin/settings/write-unlock', {
      enabled: false,
    });
    expect(globalApplied.status).toBe(200);
    expect((await resolveWriteUnlock(profileId, member.id)).blocker).toBe('global');
  });
});

describe('documents written by an older build', () => {
  it('loads without the new keys and keeps the permissive defaults', async () => {
    // A settings.json written before the global switch existed.
    const { writeUnlockEnabled: _switch, ...legacySettings } = DEFAULT_SETTINGS;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      path.join(DATA_DIR, 'settings.json'),
      JSON.stringify(legacySettings),
      'utf8',
    );
    settingsStore.invalidate();
    const settings = await getSettings();
    expect(settings.writeUnlockEnabled).toBe(true);

    // A users.json written before the per-account lock existed.
    const user = await createUser({
      username: `legacy-${randomUUID().slice(0, 8)}`,
      displayName: 'Legacy',
      password: TEST_CRED,
      role: 'member',
    });
    const usersFile = path.join(DATA_DIR, 'users.json');
    const stored = JSON.parse(await fs.readFile(usersFile, 'utf8')) as {
      users: Record<string, unknown>[];
    };
    for (const entry of stored.users) delete entry.writeUnlockDisabled;
    await fs.writeFile(usersFile, JSON.stringify(stored), 'utf8');
    usersStore.invalidate();
    await refreshWriteUnlockMirror();
    const reloaded = await findUserById(user.id);
    // The legacy document has no key at all, and the account is not disabled.
    expect(reloaded?.writeUnlockDisabled).toBeUndefined();
    const [publicUser] = (await listUsers()).filter((entry) => entry.id === user.id);
    expect(publicUser?.writeUnlockDisabled).toBe(false);
  });
});
