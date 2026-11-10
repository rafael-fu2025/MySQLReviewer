import { Router } from 'express';
import { z } from 'zod';
import { getWorkspace, saveWorkspace } from '../store/workspace';
import { currentUser } from '../auth';
import { asyncHandler, parseBody } from './util';

/**
 * The signed-in user's query workspace. Caps mirror the store's write-time
 * clamps, so an oversized client payload is rejected up front instead of
 * being silently truncated on save.
 */
const WorkspaceTabSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().max(500),
  sql: z.string().max(200_000),
});

const WorkspaceSchema = z.object({
  tabs: z.array(WorkspaceTabSchema).max(30),
  activeId: z.string().max(120),
});

export const workspaceRouter = Router();

workspaceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ data: await getWorkspace(user.id) });
  }),
);

workspaceRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(WorkspaceSchema, req);
    await saveWorkspace(user.id, body);
    res.json({ data: { saved: true } });
  }),
);
