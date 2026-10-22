import { Router } from 'express';
import { getGlobalStatus, getGlobalVariables, getPerformanceSnapshot } from '../db/metrics';
import { assertServerWideAllowed } from '../db/scope';
import { asyncHandler, param } from './util';

export const metricsRouter = Router();

metricsRouter.get(
  '/:profileId/performance',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId);
    res.json({ data: await getPerformanceSnapshot(profileId) });
  }),
);

metricsRouter.get(
  '/:profileId/variables',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId);
    const variables = await getGlobalVariables(profileId);
    res.json({ data: variables });
  }),
);

metricsRouter.get(
  '/:profileId/status',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId);
    const status = await getGlobalStatus(profileId);
    res.json({ data: status });
  }),
);
