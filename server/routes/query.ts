import { Router } from 'express';
import { z } from 'zod';
import { executeQuery } from '../db/query';
import { runExplain } from '../db/explain';
import { killProcess } from '../db/metrics';
import { isWritesUnlocked } from '../db/manager';
import { assertServerWideAllowed } from '../db/scope';
import { AppError } from '../errors';
import { asyncHandler, param, parseBody } from './util';

const QueryBody = z.object({
  sql: z.string().min(1).max(1_000_000),
  database: z.string().max(200).nullable().optional(),
  revealSensitive: z.boolean().optional(),
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
    const profileId = param(req, 'profileId');
    const body = parseBody(QueryBody, req);
    if (body.revealSensitive === true && !isWritesUnlocked(profileId)) {
      throw new AppError(
        'REVEAL_LOCKED',
        'Unlock writes for this connection before revealing masked values.',
        403,
      );
    }
    const result = await executeQuery(profileId, body.sql, {
      database: body.database ?? null,
      revealSensitive: body.revealSensitive === true,
    });
    res.json({ data: result });
  }),
);

queryRouter.post(
  '/:profileId/explain',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const body = parseBody(ExplainBody, req);
    const result = await runExplain(
      profileId,
      body.sql,
      body.database ?? null,
      { analyze: Boolean(body.analyze) },
    );
    res.json({ data: result });
  }),
);

queryRouter.post(
  '/:profileId/kill',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const body = parseBody(KillBody, req);
    await assertServerWideAllowed(profileId);
    if (!isWritesUnlocked(profileId)) {
      throw new AppError(
        'WRITE_LOCKED',
        'Unlock writes for this connection before killing a session.',
        403,
      );
    }
    await killProcess(profileId, body.processId);
    res.json({ data: { killed: true, processId: body.processId } });
  }),
);
