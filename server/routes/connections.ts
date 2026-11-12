import { Router } from 'express';
import { z } from 'zod';
import type { ConnectResult, TestConnectionResult, UnlockResult } from '../../shared/types';
import {
  connectProfile,
  disconnectProfile,
  invalidateProfile,
  isWritesUnlocked,
  lockWrites,
  testConnection,
  unlockState,
  unlockWrites,
} from '../db/manager';
import { listDatabases } from '../db/introspection';
import { generateGrantSql } from '../db/grants';
import { publishDatabaseToMembers } from '../db/publish';
import { AppError } from '../errors';
import { assertProfileAssigned, requireAdmin, sandboxScopeOverride } from '../auth';
import { logActivity } from '../store/activity';
import { findUserById, resolveWriteUnlock } from '../store/users';
import {
  createProfile,
  deleteProfile,
  getProfile,
  getStoredProfile,
  listProfiles,
  resolveProfilePassword,
  updateProfile,
} from '../store/profiles';
import { asyncHandler, parseBody, param } from './util';

const SslSchema = z
  .object({
    enabled: z.boolean(),
    rejectUnauthorized: z.boolean().optional(),
    ca: z.string().max(200_000).optional(),
    cert: z.string().max(200_000).optional(),
    key: z.string().max(200_000).optional(),
  })
  .optional();

const ConnectionSchema = z.object({
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65_535),
  user: z.string().min(1).max(128),
  password: z.string().max(2_000).optional(),
  database: z.string().max(200).optional(),
  socketPath: z.string().max(1_000).optional(),
  ssl: SslSchema,
  rememberPassword: z.boolean().optional(),
  color: z.string().max(40).optional(),
  databaseScope: z.enum(['all', 'selected']).optional(),
  allowedDatabases: z.array(z.string().max(200)).max(200).optional(),
  allowServerWideInsights: z.boolean().optional(),
  /**
   * Whether members may write through this connection. `locked` makes it
   * read-only for members; an administrator keeps full write access.
   */
  writeAccess: z.enum(['full', 'locked']).optional(),
});

const TestSchema = ConnectionSchema.extend({
  profileId: z.string().max(200).optional(),
  includeDatabases: z.boolean().optional(),
});

const ConnectSchema = z.object({}).strict();

const UnlockSchema = z.object({
  phrase: z.string().max(100),
});

export const connectionsRouter = Router();

/**
 * The unlock state as the policy sees it. An account the policy forbids from
 * unlocking has no grant, even if one is still sitting in memory.
 */
async function effectiveUnlockState(profileId: string, userId: string): Promise<UnlockResult> {
  const user = await findUserById(userId);
  if (user?.role === 'admin') {
    return { unlocked: true, until: null, ttlSeconds: 0 };
  }
  const state = unlockState(profileId, userId);
  const decision = await resolveWriteUnlock(profileId, userId);
  if (decision.permitted) return state;
  return { unlocked: false, until: null, ttlSeconds: 0 };
}

export interface PasswordReuseTarget {
  host: string;
  port: number;
  user: string;
  socketPath?: string | null;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The databases this save publishes to the members of the connection.
 *
 * A database counts as newly published when it is on the allowlist now and
 * was not on it before. A database that was already published keeps the
 * clones the members already have: re-cloning it would replace their work.
 */
function newlyPublishedDatabases(
  previous: { databaseScope?: 'all' | 'selected'; allowedDatabases?: string[] } | null,
  profile: { databaseScope: 'all' | 'selected'; allowedDatabases: string[] },
): string[] {
  if (profile.databaseScope !== 'selected') return [];
  const before = new Set(
    previous?.databaseScope === 'selected' ? (previous.allowedDatabases ?? []) : [],
  );
  return profile.allowedDatabases.filter((database) => !before.has(database));
}

function normalizeSocketPath(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

/**
 * The saved password may only be reused when the test targets the exact same
 * server and account it was saved for. Otherwise editing the host and pressing
 * "Test" would ship the stored credential to a different server.
 */
export function canReuseStoredPassword(
  stored: PasswordReuseTarget,
  candidate: PasswordReuseTarget,
): boolean {
  return (
    normalizeHost(stored.host) === normalizeHost(candidate.host) &&
    stored.port === candidate.port &&
    stored.user === candidate.user &&
    normalizeSocketPath(stored.socketPath) === normalizeSocketPath(candidate.socketPath)
  );
}

connectionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user;
    const all = await listProfiles();
    // Members see only the connections assigned to them.
    const data =
      user && user.role === 'member'
        ? all.filter((profile) =>
            user.assignments.some((assignment) => assignment.profileId === profile.id),
          )
        : all;
    res.json({ data });
  }),
);

connectionsRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    // Testing probes arbitrary hosts with supplied credentials — that is an
    // admin capability, not something a member account should be able to do.
    requireAdmin(req);
    const body = parseBody(TestSchema, req);
    let password = body.password;
    if (password === undefined && body.profileId) {
      const stored = await getStoredProfile(body.profileId).catch(() => null);
      if (stored) {
        if (!canReuseStoredPassword(stored, body)) {
          throw new AppError(
            'PASSWORD_REQUIRED',
            'The saved password is only reused when the host, port, user, and socket path match the saved connection. Enter the password to test these settings.',
            400,
          );
        }
        password = await resolveProfilePassword(body.profileId);
      }
    }
    const result: TestConnectionResult = await testConnection(
      {
        ...body,
        password: password ?? '',
      },
      { includeDatabases: body.includeDatabases === true },
    );
    res.json({ data: result });
  }),
);

connectionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireAdmin(req);
    const body = parseBody(ConnectionSchema, req);
    const profile = await createProfile(body);
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'admin-connection-create',
      profileId: profile.id,
      detail: `"${profile.name}" (${profile.user}@${profile.host}:${profile.port})`,
    });
    res.status(201).json({ data: profile });
  }),
);

connectionsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireAdmin(req);
    const id = param(req, 'id');
    const body = parseBody(ConnectionSchema, req);
    const previous = await getStoredProfile(id).catch(() => null);
    const profile = await updateProfile(id, body);
    await invalidateProfile(id);

    // Publishing a database reaches the members as a clone, not as the live
    // schema: a member works in their own copy so their writes never touch
    // the administrator's data. Only a database that was newly published is
    // provisioned — one that was already on the allowlist has been handed
    // out before, and re-cloning it would throw away the members' work.
    const published = newlyPublishedDatabases(previous, profile);
    const clones = [];
    for (const source of published) {
      try {
        const result = await publishDatabaseToMembers(id, source);
        clones.push(result);
      } catch (error) {
        // The connection itself is saved. A clone that could not be made is
        // reported, not fatal: the administrator can retry from the Admin
        // page without losing the allowlist change.
        clones.push({
          source,
          sandboxes: [],
          skipped: [],
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }

    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'admin-connection-update',
      profileId: id,
      detail: `"${profile.name}" updated`,
    });
    res.json({ data: { ...profile, clones } });
  }),
);

connectionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireAdmin(req);
    const id = param(req, 'id');
    const profile = await getProfile(id);
    await invalidateProfile(id);
    await deleteProfile(id);
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'admin-connection-delete',
      profileId: id,
      detail: `"${profile.name}" deleted`,
    });
    res.json({ data: { deleted: true } });
  }),
);

/**
 * Publishes the connection's databases to its members on demand: every
 * member receives a clone of every published database they do not have yet.
 *
 * The Admin page calls this after the allowlist changes, and it is also the
 * way to catch up a member who was added after a database was published.
 */
connectionsRouter.post(
  '/:id/publish',
  asyncHandler(async (req, res) => {
    const user = requireAdmin(req);
    const id = param(req, 'id');
    await getProfile(id);
    const body = parseBody(
      z.object({
        databases: z.array(z.string().min(1).max(200)).max(100).optional(),
        includeData: z.boolean().optional(),
      }),
      req,
    );
    const profile = await getStoredProfile(id);
    if (profile.databaseScope !== 'selected') {
      throw new AppError(
        'VALIDATION',
        'Publish a database on a connection that is limited to selected databases.',
        400,
      );
    }
    const sources =
      body.databases && body.databases.length > 0
        ? body.databases
        : (profile.allowedDatabases ?? []);
    const results = [];
    for (const source of sources) {
      try {
        results.push(
          await publishDatabaseToMembers(id, source, {
            includeData: body.includeData !== false,
          }),
        );
      } catch (error) {
        results.push({
          source,
          sandboxes: [],
          skipped: [],
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'admin-sandbox-provision',
      profileId: id,
      detail: `${results.length} database(s) published to members`,
    });
    res.json({ data: { results } });
  }),
);

connectionsRouter.post(
  '/:id/grant-sql',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = param(req, 'id');
    await getProfile(id);
    const body = parseBody(
      z.object({
        user: z.string().min(1).max(80),
        host: z.string().min(1).max(255).optional(),
        databases: z.array(z.string().min(1).max(200)).min(1).max(100),
        privileges: z.array(z.string().max(60)).max(20).optional(),
      }),
      req,
    );
    res.json({
      data: generateGrantSql({ ...body, host: body.host ?? 'localhost' }),
    });
  }),
);

connectionsRouter.post(
  '/:id/connect',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'id'));
    const id = param(req, 'id');
    parseBody(ConnectSchema, req);
    await getProfile(id);
    const server = await connectProfile(id);
    const override = sandboxScopeOverride(user, id);
    const databases = await listDatabases(id, override);
    const result: ConnectResult = {
      server,
      databases,
      unlock: await effectiveUnlockState(id, user.id),
    };
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'connect',
      profileId: id,
      detail: `${server.flavor} ${server.version}`,
    });
    res.json({ data: result });
  }),
);

connectionsRouter.post(
  '/:id/disconnect',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'id'));
    const id = param(req, 'id');
    if (user.role === 'admin') {
      await disconnectProfile(id);
      lockWrites(id, user.id, { profileWide: true });
    } else {
      // Pools are shared process resources. A member disconnect is a personal
      // state transition only and may not tear down in-flight work for others.
      lockWrites(id, user.id, { profileWide: false });
    }
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'disconnect',
      profileId: id,
    });
    res.json({ data: { disconnected: true } });
  }),
);

connectionsRouter.get(
  '/:id/unlock',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'id'));
    const id = param(req, 'id');
    res.json({ data: await effectiveUnlockState(id, user.id) });
  }),
);

connectionsRouter.post(
  '/:id/unlock',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'id'));
    const id = param(req, 'id');
    if (user.role === 'admin') {
      res.json({
        data: {
          unlocked: true,
          until: null,
          ttlSeconds: 0,
        },
      });
      return;
    }
    // The policy is checked before the phrase: an account the policy forbids
    // from unlocking must not be able to open a grant at all.
    const decision = await resolveWriteUnlock(id, user.id);
    if (!decision.permitted) {
      throw new AppError('WRITE_UNLOCK_DISABLED', decision.message, 403, {
        blocker: decision.blocker,
      });
    }
    const body = parseBody(UnlockSchema, req);
    if (!isWritesUnlocked(id, user.id)) {
      // The server performs the phrase check; this call also validates the profile.
      await getProfile(id);
    }
    const result = unlockWrites(id, user.id, body.phrase, {
      profileWide: false,
    });
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'unlock',
      profileId: id,
      detail: result.unlocked ? 'Writes unlocked for 15 minutes' : 'Unlock attempt failed',
    });
    res.json({ data: result });
  }),
);

connectionsRouter.post(
  '/:id/lock',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'id'));
    const id = param(req, 'id');
    if (user.role === 'admin') {
      res.json({ data: { unlocked: true, until: null, ttlSeconds: 0 } });
      return;
    }
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'lock',
      profileId: id,
    });
    res.json({ data: lockWrites(id, user.id, { profileWide: false }) });
  }),
);
