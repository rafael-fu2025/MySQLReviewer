import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';
import { requireAdmin } from '../auth';
import { dropSandbox, nextSandboxName, provisionSandbox, resetSandbox } from '../db/provision';
import { invalidateSchemaCache } from '../db/introspection';
import { logActivity } from '../store/activity';
import { listActivity } from '../store/activity';
import { deleteSessionsForUser } from '../store/sessions';
import {
  addAssignment,
  createUser,
  deleteUser,
  listUsers,
  patchAssignment,
  removeAssignment,
  setWriteUnlockDisabled,
  updateUser,
  findUserById,
} from '../store/users';
import { getStoredProfile } from '../store/profiles';
import { updateSettings } from '../store/settings';
import { revokeAllWriteGrants, revokeWriteGrantsForUser } from '../db/manager';
import { parseBody } from './util';
import crypto from 'node:crypto';

const router = Router();

router.use((req, _res, next) => {
  try {
    requireAdmin(req);
    next();
  } catch (error) {
    next(error);
  }
});

const AssignmentSchema = z.object({
  profileId: z.string().min(1),
  source: z.string().min(1).max(64),
  includeData: z.boolean(),
});

const CreateUserSchema = z.object({
  username: z.string().trim().min(2).max(40),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(6).max(200),
  role: z.enum(['admin', 'member']),
});

const UpdateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(6).max(200).optional(),
});

const WriteUnlockAccountSchema = z.object({
  disabled: z.boolean(),
});

const WriteUnlockSwitchSchema = z.object({
  enabled: z.boolean(),
});

router.get('/users', async (_req, res, next) => {
  try {
    res.json({ data: await listUsers() });
  } catch (error) {
    next(error);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const body = parseBody(CreateUserSchema, req);
    const admin = requireAdmin(req);
    const user = await createUser({
      username: body.username,
      displayName: body.displayName,
      password: body.password,
      role: body.role,
    });
    await logActivity({
      userId: admin.id,
      username: admin.username,
      action: 'admin-user-create',
      detail: `${user.role} "${user.username}" created`,
    });
    res.json({ data: user });
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const admin = requireAdmin(req);
    const body = parseBody(UpdateUserSchema, req);
    if (req.params.id === admin.id && body.disabled === true) {
      throw new AppError('LAST_ADMIN', 'You cannot disable your own account.', 400);
    }
    const user = await updateUser(req.params.id, body);
    if (!user) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    // A password reset must invalidate every session that was issued for the
    // old password; disabling an account revokes its sessions as well.
    if (body.disabled === true || body.password !== undefined) {
      await deleteSessionsForUser(user.id);
    }
    await logActivity({
      userId: admin.id,
      username: admin.username,
      action: 'admin-user-update',
      detail: `"${user.username}" updated${body.password ? ' (password reset)' : ''}${body.disabled !== undefined ? ` (${body.disabled ? 'disabled' : 'enabled'})` : ''}`,
    });
    res.json({ data: user });
  } catch (error) {
    next(error);
  }
});

/**
 * Turns the per-account write lock on or off. While it is on the account can
 * never unlock writes and can never reveal masked values, even while the
 * global write-unlock switch is on. Admin accounts cannot be locked.
 */
router.put('/users/:id/write-unlock', async (req, res, next) => {
  try {
    const admin = requireAdmin(req);
    const body = parseBody(WriteUnlockAccountSchema, req);
    const target = await findUserById(req.params.id);
    if (!target) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    if (target.role === 'admin') {
      throw new AppError(
        'ADMIN_WRITE_UNLOCK_NOT_APPLICABLE',
        'Admin accounts always have full write access and cannot be locked.',
        400,
      );
    }
    const user = await setWriteUnlockDisabled(req.params.id, body.disabled);
    if (!user) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    if (body.disabled) {
      // Drop any grant the account is holding right now, on every profile: the
      // lock has to bite immediately, not when the 15-minute window runs out.
      revokeWriteGrantsForUser(user.id);
    }
    await logActivity({
      userId: admin.id,
      username: admin.username,
      action: 'admin-user-update',
      detail: `"${user.username}" ${
        body.disabled ? 'can no longer unlock writes' : 'can unlock writes again'
      }`,
    });
    res.json({ data: user });
  } catch (error) {
    next(error);
  }
});

/**
 * The global write-unlock switch. Turning it off puts the app in hard
 * read-only mode for members: members cannot unlock writes or reveal
 * masked values. Admin accounts always retain unrestricted write access.
 */
router.put('/settings/write-unlock', async (req, res, next) => {
  try {
    const admin = requireAdmin(req);
    const body = parseBody(WriteUnlockSwitchSchema, req);
    const settings = await updateSettings({ writeUnlockEnabled: body.enabled });
    if (!body.enabled) {
      // The switch closes every grant, not just the administrator's: a live
      // grant must not survive and revive when the switch is turned back on.
      revokeAllWriteGrants();
    }
    await logActivity({
      userId: admin.id,
      username: admin.username,
      action: 'admin-write-unlock-switch',
      detail: body.enabled
        ? 'Write unlocking enabled for every account'
        : 'Write unlocking disabled for every account',
    });
    res.json({ data: settings });
  } catch (error) {
    next(error);
  }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const admin = requireAdmin(req);
    if (req.params.id === admin.id) {
      throw new AppError('LAST_ADMIN', 'You cannot delete your own account.', 400);
    }
    const user = await findUserById(req.params.id);
    if (!user) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    await deleteUser(req.params.id);
    await deleteSessionsForUser(req.params.id);
    await logActivity({
      userId: admin.id,
      username: admin.username,
      action: 'admin-user-delete',
      detail: `"${user.username}" deleted`,
    });
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

/**
 * Assigns a sandbox to a member: clones the source database into
 * `<source>_<n>` and records the assignment. One sandbox per source database
 * per member — reassigning the same source reuses that sandbox.
 */
router.post('/users/:id/assignments', async (req, res, next) => {
  try {
    const admin = requireAdmin(req);
    const body = parseBody(AssignmentSchema, req);
    const user = await findUserById(req.params.id);
    if (!user) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    const profile = await getStoredProfile(body.profileId);
    if (!profile) throw new AppError('PROFILE_NOT_FOUND', 'That connection does not exist.', 404);

    const existing = user.assignments.find(
      (assignment) => assignment.profileId === body.profileId && assignment.source === body.source,
    );
    if (existing) {
      throw new AppError(
        'ASSIGNMENT_EXISTS',
        `"${user.username}" already has the sandbox "${existing.sandbox}" for ${body.source}.`,
        409,
      );
    }

    const sandbox = await nextSandboxName(body.profileId, body.source);
    const result = await provisionSandbox(body.profileId, body.source, sandbox, body.includeData);
    const assignment = {
      id: crypto.randomBytes(6).toString('base64url'),
      profileId: body.profileId,
      source: body.source,
      sandbox: result.sandbox,
      includeData: body.includeData,
      createdAt: new Date().toISOString(),
      lastResetAt: null,
    };
    // The assignment is appended inside the store's serialization queue: a
    // concurrent provisioning cannot wipe this member's other sandboxes.
    const updated = await addAssignment(user.id, assignment);
    if (!updated) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    invalidateSchemaCache(body.profileId, result.sandbox);
    await logActivity({
      userId: admin.id,
      username: admin.username,
      action: 'admin-sandbox-provision',
      profileId: body.profileId,
      database: result.sandbox,
      detail: `${result.tables} tables · ${result.rowsCopied} rows copied for "${user.username}"`,
    });
    res.json({ data: { user: updated, result } });
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/assignments/:assignmentId/reset', async (req, res, next) => {
  try {
    const admin = requireAdmin(req);
    const user = await findUserById(req.params.id);
    if (!user) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    const assignment = user.assignments.find((a) => a.id === req.params.assignmentId);
    if (!assignment) throw new AppError('ASSIGNMENT_NOT_FOUND', 'No such sandbox.', 404);
    const result = await resetSandbox(
      assignment.profileId,
      assignment.source,
      assignment.sandbox,
      assignment.includeData,
    );
    const updated = await patchAssignment(user.id, assignment.id, {
      lastResetAt: new Date().toISOString(),
    });
    if (!updated) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    invalidateSchemaCache(assignment.profileId, assignment.sandbox);
    await logActivity({
      userId: admin.id,
      username: admin.username,
      action: 'admin-sandbox-reset',
      profileId: assignment.profileId,
      database: assignment.sandbox,
      detail: `Re-cloned from ${assignment.source} for "${user.username}"`,
    });
    res.json({ data: { user: updated, result } });
  } catch (error) {
    next(error);
  }
});

router.delete('/users/:id/assignments/:assignmentId', async (req, res, next) => {
  try {
    const admin = requireAdmin(req);
    const user = await findUserById(req.params.id);
    if (!user) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    const assignment = user.assignments.find((a) => a.id === req.params.assignmentId);
    if (!assignment) throw new AppError('ASSIGNMENT_NOT_FOUND', 'No such sandbox.', 404);
    await dropSandbox(assignment.profileId, assignment.sandbox);
    const updated = await removeAssignment(user.id, assignment.id);
    if (!updated) throw new AppError('USER_NOT_FOUND', 'That user does not exist.', 404);
    await logActivity({
      userId: admin.id,
      username: admin.username,
      action: 'admin-sandbox-reset',
      profileId: assignment.profileId,
      database: assignment.sandbox,
      detail: `Sandbox removed for "${user.username}"`,
    });
    res.json({ data: { user: updated } });
  } catch (error) {
    next(error);
  }
});

router.get('/activity', async (req, res, next) => {
  try {
    requireAdmin(req);
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const limit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    res.json({
      data: await listActivity({
        userId: userId || undefined,
        limit: Number.isFinite(limit) ? limit : 20,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
    });
  } catch (error) {
    next(error);
  }
});

export { router as adminRouter };
