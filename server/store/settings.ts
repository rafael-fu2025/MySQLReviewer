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
    // Absent in a settings file written before the switch existed: unlocking
    // stays enabled, so an older build's settings keep their behaviour.
    writeUnlockEnabled: input.writeUnlockEnabled ?? base.writeUnlockEnabled,
    disabledAgentTools: sanitizeDisabledAgentTools(
      input.disabledAgentTools ?? base.disabledAgentTools ?? [],
    ),
    mcpServers: sanitizeMcpServers(input.mcpServers ?? base.mcpServers ?? []),
  };
}

/** Deduplicates, trims and caps the disabled-tool list. */
function sanitizeDisabledAgentTools(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, 60);
    if (trimmed) seen.add(trimmed);
    if (seen.size >= 60) break;
  }
  return [...seen];
}

/** Keeps at most 3 well-formed MCP server configs with unique names. */
function sanitizeMcpServers(servers: AppSettings['mcpServers']): AppSettings['mcpServers'] {
  const seen = new Set<string>();
  const clean: NonNullable<AppSettings['mcpServers']> = [];
  for (const server of servers ?? []) {
    if (clean.length >= 3) break;
    const name = String(server?.name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '')
      .slice(0, 40);
    const command = String(server?.command ?? '')
      .trim()
      .slice(0, 500);
    if (!name || !command || seen.has(name)) continue;
    seen.add(name);
    clean.push({
      name,
      command,
      args: (server?.args ?? [])
        .filter((arg): arg is string => typeof arg === 'string')
        .slice(0, 20),
      allowedTools: (server?.allowedTools ?? [])
        .filter((tool): tool is string => typeof tool === 'string')
        .slice(0, 50),
    });
  }
  return clean;
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await store.read();
  return sanitize(stored, DEFAULT_SETTINGS);
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // The read-modify-write happens inside the store's serialization queue, so
  // two concurrent updates cannot discard each other's fields.
  return store.update((current) => sanitize(patch, sanitize(current, DEFAULT_SETTINGS)));
}

export async function setDefaultAiProvider(providerId: string | null): Promise<AppSettings> {
  return updateSettings({ defaultAiProviderId: providerId });
}

export { store as settingsStore };
