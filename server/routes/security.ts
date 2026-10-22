import { Router } from 'express';
import type { SecurityAuditResult } from '../../shared/types';
import { collectSecurityData, getGrants } from '../db/security-audit';
import { getGlobalVariables } from '../db/metrics';
import { getCachedServerInfo } from '../db/manager';
import { assertServerWideAllowed } from '../db/scope';
import { dedupeFindings } from '../review/findings';
import { runConfigRules, runSecurityRules } from '../review/rules';
import { asyncHandler, param } from './util';

export const securityRouter = Router();

securityRouter.get(
  '/:profileId/security',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId);
    const variables = await getGlobalVariables(profileId);
    const server = getCachedServerInfo(profileId);
    const data = await collectSecurityData(profileId, variables);
    const findings = dedupeFindings([
      ...runSecurityRules(data),
      ...runConfigRules(variables, server).filter(
        (finding) => finding.category === 'security' || finding.category === 'config',
      ),
    ]);
    const result: SecurityAuditResult = {
      users: data.users,
      findings,
      config: data.config,
      coverage: data.coverage,
      generatedAt: data.generatedAt,
    };
    res.json({ data: result });
  }),
);

securityRouter.get(
  '/:profileId/users/:user/:host/grants',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    await assertServerWideAllowed(profileId);
    const user = param(req, 'user');
    const host = param(req, 'host');
    res.json({ data: await getGrants(profileId, user, host) });
  }),
);
