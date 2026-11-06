import { Router } from 'express';
import { getGrants, runSecurityAudit } from '../db/security-audit';
import { assertServerWideAllowed } from '../db/scope';
import { assertProfileAssigned, sandboxScopeOverride } from '../auth';
import { asyncHandler, param } from './util';

export const securityRouter = Router();

securityRouter.get(
  '/:profileId/security',
  asyncHandler(async (req, res) => {
    assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId, sandboxScopeOverride(req.user, profileId));
    res.json({ data: await runSecurityAudit(profileId) });
  }),
);

securityRouter.get(
  '/:profileId/users/:user/:host/grants',
  asyncHandler(async (req, res) => {
    assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId, sandboxScopeOverride(req.user, profileId));
    const user = param(req, 'user');
    const host = param(req, 'host');
    res.json({ data: await getGrants(profileId, user, host) });
  }),
);
