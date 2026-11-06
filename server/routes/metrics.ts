import { Router } from 'express';
import { getGlobalStatus, getGlobalVariables, getPerformanceSnapshot } from '../db/metrics';
import { assertServerWideAllowed } from '../db/scope';
import { assertProfileAssigned, sandboxScopeOverride } from '../auth';
import { asyncHandler, param } from './util';

export const metricsRouter = Router();

metricsRouter.get(
  '/:profileId/performance',
  asyncHandler(async (req, res) => {
    assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId, sandboxScopeOverride(req.user, profileId));
    res.json({
      data: await getPerformanceSnapshot(profileId, sandboxScopeOverride(req.user, profileId)),
    });
  }),
);

metricsRouter.get(
  '/:profileId/variables',
  asyncHandler(async (req, res) => {
    assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId, sandboxScopeOverride(req.user, profileId));
    const variables = await getGlobalVariables(profileId);
    res.json({ data: variables });
  }),
);

metricsRouter.get(
  '/:profileId/status',
  asyncHandler(async (req, res) => {
    assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId, sandboxScopeOverride(req.user, profileId));
    const status = await getGlobalStatus(profileId);
    res.json({ data: status });
  }),
);
