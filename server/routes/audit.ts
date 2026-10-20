import { Router } from 'express';
import { z } from 'zod';
import { getCachedServerInfo, connectProfile } from '../db/manager';
import { assertServerWideAllowed } from '../db/scope';
import { resolveProvider } from '../store/providers';
import { runAudit } from '../review/audit';
import { openSse } from '../sse';
import { asyncHandler, parseBody } from './util';

const AuditSchema = z.object({
  profileId: z.string().min(1).max(200),
  databases: z.array(z.string().min(1).max(200)).min(1).max(100),
  includeAi: z.boolean().optional(),
  providerId: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
});

export const auditRouter = Router();

auditRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    const body = parseBody(AuditSchema, req);
    // Audits read server-wide telemetry, so enforce the connection scope before
    // any database work starts. Throws the standard scope error shape.
    await assertServerWideAllowed(body.profileId);
    const server =
      getCachedServerInfo(body.profileId) ?? (await connectProfile(body.profileId));

    if (body.includeAi && body.providerId) {
      const resolved = await resolveProvider(body.providerId);
      const provider = body.model?.trim()
        ? { ...resolved.public, model: body.model.trim() }
        : resolved.public;
      const sse = openSse(req, res);
      const controller = new AbortController();
      res.on('close', () => controller.abort());

      try {
        const report = await runAudit({
          profileId: body.profileId,
          databases: body.databases,
          server,
          ai: {
            provider,
            apiKey: resolved.apiKey,
            onDelta: (text) => sse.send('ai-delta', { text }),
            signal: controller.signal,
          },
          onProgress: (event) => {
            if (event.step) sse.send('step', event.step);
            if (event.percent != null) {
              sse.send('progress', {
                percent: event.percent,
                message: event.message ?? '',
              });
            }
          },
        });
        sse.send('report', { report });
        sse.send('done', {});
      } catch (error) {
        sse.send('error', {
          message: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string }).code ?? 'AUDIT_ERROR',
        });
      } finally {
        sse.close();
      }
      return;
    }

    const sse = openSse(req, res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const report = await runAudit({
        profileId: body.profileId,
        databases: body.databases,
        server,
        onProgress: (event) => {
          if (event.step) sse.send('step', event.step);
          if (event.percent != null) {
            sse.send('progress', {
              percent: event.percent,
              message: event.message ?? '',
            });
          }
        },
      });
      sse.send('report', { report });
      sse.send('done', {});
    } catch (error) {
      sse.send('error', {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code ?? 'AUDIT_ERROR',
      });
    } finally {
      sse.close();
    }
  }),
);
