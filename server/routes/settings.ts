import { Router } from 'express';
import { z } from 'zod';
import { getProvider } from '../store/providers';
import { getSettings, updateSettings } from '../store/settings';
import { AppError } from '../errors';
import { asyncHandler, parseBody } from './util';

const SettingsSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']).optional(),
    rowLimit: z.number().int().min(1).max(10_000).optional(),
    queryTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    cellMaxChars: z.number().int().min(256).max(1_000_000).optional(),
    liveLint: z.boolean().optional(),
    includeSchemaByDefault: z.boolean().optional(),
    aiContextChars: z.number().int().min(2_000).max(200_000).optional(),
    defaultAiProviderId: z.string().max(200).nullable().optional(),
    historyLimit: z.number().int().min(50).max(5_000).optional(),
    showHints: z.boolean().optional(),
    maskSensitiveColumns: z.boolean().optional(),
  })
  .strict();

export const settingsRouter = Router();

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await getSettings() });
  }),
);

settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(SettingsSchema, req);
    if (body.defaultAiProviderId) {
      try {
        await getProvider(body.defaultAiProviderId);
      } catch {
        throw new AppError(
          'PROVIDER_NOT_FOUND',
          'The selected default AI provider does not exist.',
          400,
        );
      }
    }
    res.json({ data: await updateSettings(body) });
  }),
);
