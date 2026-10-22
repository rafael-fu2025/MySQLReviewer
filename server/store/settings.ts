import path from 'node:path';
import { DATA_DIR, clampInt } from '../config';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types';
import { JsonStore } from './json-store';

const store = new JsonStore<AppSettings>(path.join(DATA_DIR, 'settings.json'), () => ({
  ...DEFAULT_SETTINGS,
}));

function sanitize(input: Partial<AppSettings>, base: AppSettings): AppSettings {
  const theme =
    input.theme === 'light' || input.theme === 'dark' || input.theme === 'system'
      ? input.theme
      : base.theme;
  return {
    theme,
    rowLimit: clampInt(input.rowLimit ?? base.rowLimit, base.rowLimit, 1, 10_000),
    queryTimeoutMs: clampInt(
      input.queryTimeoutMs ?? base.queryTimeoutMs,
      base.queryTimeoutMs,
      1_000,
      300_000,
    ),
    cellMaxChars: clampInt(
      input.cellMaxChars ?? base.cellMaxChars,
      base.cellMaxChars,
      256,
      1_000_000,
    ),
    liveLint: input.liveLint ?? base.liveLint,
    includeSchemaByDefault: input.includeSchemaByDefault ?? base.includeSchemaByDefault,
    aiContextChars: clampInt(
      input.aiContextChars ?? base.aiContextChars,
      base.aiContextChars,
      2_000,
      200_000,
    ),
    defaultAiProviderId:
      input.defaultAiProviderId === undefined
        ? base.defaultAiProviderId
        : input.defaultAiProviderId,
    historyLimit: clampInt(input.historyLimit ?? base.historyLimit, base.historyLimit, 50, 5_000),
    showHints: input.showHints ?? base.showHints,
    maskSensitiveColumns: input.maskSensitiveColumns ?? base.maskSensitiveColumns,
  };
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await store.read();
  return sanitize(stored, DEFAULT_SETTINGS);
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = sanitize(patch, current);
  await store.write(next);
  return next;
}

export async function setDefaultAiProvider(providerId: string | null): Promise<AppSettings> {
  return updateSettings({ defaultAiProviderId: providerId });
}

export { store as settingsStore };
