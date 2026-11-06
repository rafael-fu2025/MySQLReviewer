import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { executeQuery } from '../db/query';
import { runExplain } from '../db/explain';
import { killProcess } from '../db/metrics';
import { resolveWriteUnlock } from '../store/users';
import { assertServerWideAllowed } from '../db/scope';
import { AppError } from '../errors';
import { assertProfileAssigned, sandboxScopeOverride } from '../auth';
import { logActivity } from '../store/activity';
import { asyncHandler, param, parseBody } from './util';

const QueryBody = z.object({
  sql: z.string().min(1).max(1_000_000),
  database: z.string().max(200).nullable().optional(),
  revealSensitive: z.boolean().optional(),
  /**
   * Where the caret is in the submitted script, as an offset into `sql`.
   * When the script holds several statements, the one under the caret runs.
   */
  cursorOffset: z.number().int().min(0).optional(),
});

const ExplainBody = z.object({
  sql: z.string().min(1).max(1_000_000),
  database: z.string().max(200).nullable().optional(),
  analyze: z.boolean().optional(),
});

const KillBody = z.object({
  processId: z.coerce.number().int().positive(),
  confirm: z.literal(true),
});

export const queryRouter = Router();

queryRouter.post(
  '/:profileId/query',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    const body = parseBody(QueryBody, req);
    if (body.revealSensitive === true) {
      const writeAccess = await resolveWriteUnlock(profileId, user.id);
      if (!writeAccess.allowed) {
        throw new AppError(
          'REVEAL_LOCKED',
          writeAccess.blocker
            ? writeAccess.message
            : 'Unlock writes for this connection before revealing masked values.',
          403,
        );
      }
    }
    const result = await executeQuery(profileId, body.sql, {
      database: body.database ?? null,
      revealSensitive: body.revealSensitive === true,
      scopeOverride: sandboxScopeOverride(req.user, profileId),
      userId: user.id,
      cursorOffset: body.cursorOffset,
    });
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'query',
      profileId,
      database: body.database ?? undefined,
      digest: createHash('sha256').update(body.sql.trim()).digest('hex').slice(0, 16),
      detail: `${result.rowCount} rows`,
    });
    res.json({ data: result });
  }),
);

queryRouter.post(
  '/:profileId/explain',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    const body = parseBody(ExplainBody, req);
    const result = await runExplain(profileId, body.sql, body.database ?? null, {
      analyze: Boolean(body.analyze),
      scopeOverride: sandboxScopeOverride(req.user, profileId),
      userId: user.id,
    });
    res.json({ data: result });
  }),
);

queryRouter.post(
  '/:profileId/kill',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    const body = parseBody(KillBody, req);
    // Members never get server-wide insight; killing sessions is admin work.
    await assertServerWideAllowed(profileId, sandboxScopeOverride(req.user, profileId));
    const writeAccess = await resolveWriteUnlock(profileId, user.id);
    if (!writeAccess.allowed) {
      throw new AppError(
        'WRITE_LOCKED',
        writeAccess.blocker
          ? writeAccess.message
          : 'Unlock writes for this connection before killing a session.',
        403,
      );
    }
    await killProcess(profileId, body.processId, sandboxScopeOverride(req.user, profileId));
    res.json({ data: { killed: true, processId: body.processId } });
  }),
);
