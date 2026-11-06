import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth';
import { getProvider } from '../store/providers';
import { getSettings, updateSettings } from '../store/settings';
import { setUserTheme } from '../store/users';
import { AppError } from '../errors';
import { asyncHandler, parseBody } from './util';

const ThemeSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']),
  })
  .strict();

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
    disabledAgentTools: z.array(z.string().max(60)).max(60).optional(),
    mcpServers: z
      .array(
        z.object({
          name: z
            .string()
            .regex(/^[a-z0-9_-]+$/)
            .max(40),
          command: z.string().min(1).max(500),
          args: z.array(z.string().max(200)).max(20).optional(),
          allowedTools: z.array(z.string().max(100)).max(50).optional(),
        }),
      )
      .max(3)
      .optional(),
  })
  .strict();

export const settingsRouter = Router();

settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    // Theme is personal: a user override wins over the admin-owned default.
    res.json({ data: { ...settings, theme: req.user?.theme ?? settings.theme } });
  }),
);

// Every signed-in account can set its own appearance. This is deliberately
// separate from PUT /: those settings shape shared server behavior and stay
// admin-only.
settingsRouter.put(
  '/theme',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(ThemeSchema, req);
    const saved = await setUserTheme(user.id, body.theme);
    if (!saved) {
      throw new AppError('USER_NOT_FOUND', 'This account no longer exists.', 404);
    }
    res.json({ data: { theme: saved.theme } });
  }),
);

settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    // Settings shape server behavior (AI, history, masking) — admin-only.
    requireAdmin(req);
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
    const saved = await updateSettings(body);
    res.json({ data: { ...saved, theme: req.user?.theme ?? saved.theme } });
  }),
);
