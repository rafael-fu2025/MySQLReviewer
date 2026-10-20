import { Router } from 'express';
import { z } from 'zod';
import type { ConnectResult, TestConnectionResult } from '../../shared/types';
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
});

const TestSchema = ConnectionSchema.extend({
  profileId: z.string().max(200).optional(),
  includeDatabases: z.boolean().optional(),
});

const ConnectSchema = z.object({
  password: z.string().max(2_000).optional(),
});

const UnlockSchema = z.object({
  phrase: z.string().max(100),
});

export const connectionsRouter = Router();

connectionsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await listProfiles() });
  }),
);

connectionsRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const body = parseBody(TestSchema, req);
    let password = body.password;
    if (password === undefined && body.profileId) {
      try {
        await getStoredProfile(body.profileId);
        password = await resolveProfilePassword(body.profileId);
      } catch {
        // The profile may have been deleted; test with the supplied data.
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
    const body = parseBody(ConnectionSchema, req);
    res.status(201).json({ data: await createProfile(body) });
  }),
);

connectionsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const body = parseBody(ConnectionSchema, req);
    const profile = await updateProfile(id, body);
    await invalidateProfile(id);
    res.json({ data: profile });
  }),
);

connectionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    await invalidateProfile(id);
    await deleteProfile(id);
    res.json({ data: { deleted: true } });
  }),
);

connectionsRouter.post(
  '/:id/grant-sql',
  asyncHandler(async (req, res) => {
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
    const id = param(req, 'id');
    const body = parseBody(ConnectSchema, req);
    await getProfile(id);
    const server = await connectProfile(id, body.password);
    const databases = await listDatabases(id);
    const result: ConnectResult = {
      server,
      databases,
      unlock: unlockState(id),
    };
    res.json({ data: result });
  }),
);

connectionsRouter.post(
  '/:id/disconnect',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    await disconnectProfile(id);
    lockWrites(id);
    res.json({ data: { disconnected: true } });
  }),
);

connectionsRouter.get(
  '/:id/unlock',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    res.json({ data: unlockState(id) });
  }),
);

connectionsRouter.post(
  '/:id/unlock',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const body = parseBody(UnlockSchema, req);
    if (!isWritesUnlocked(id)) {
      // The server performs the phrase check; this call also validates the profile.
      await getProfile(id);
    }
    res.json({ data: unlockWrites(id, body.phrase) });
  }),
);

connectionsRouter.post(
  '/:id/lock',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    res.json({ data: lockWrites(id) });
  }),
);
