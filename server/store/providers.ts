import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import type { AiProvider, AiProviderInput, AiProviderType } from '../../shared/types';
import { decryptSecret, encryptSecret, maskSecret } from './crypto';
import { JsonStore } from './json-store';
import { getSettings, setDefaultAiProvider } from './settings';

interface StoredProvider {
  id: string;
  name: string;
  type: AiProviderType;
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
  model: string;
  models: string[];
  apiKeyEnc?: string | null;
  authHeader: string;
  authPrefix: string;
  /** Header values are encrypted at rest; legacy plaintext values still read back. */
  headers: Record<string, string>;
  extraBody: Record<string, unknown>;
  temperature: number;
  maxTokens: number;
  streaming: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProviderFile {
  providers: StoredProvider[];
}

const store = new JsonStore<ProviderFile>(path.join(DATA_DIR, 'providers.json'), () => ({
  providers: [],
}));

const DEFAULTS: Record<
  AiProviderType,
  { chatPath: string; modelsPath: string; authHeader: string; authPrefix: string }
> = {
  openai: {
    chatPath: '/chat/completions',
    modelsPath: '/models',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
  anthropic: {
    chatPath: '/v1/messages',
    modelsPath: '/v1/models',
    authHeader: 'x-api-key',
    authPrefix: '',
  },
  google: {
    chatPath: '',
    modelsPath: '/models',
    authHeader: '',
    authPrefix: '',
  },
};

function now(): string {
  return new Date().toISOString();
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizePath(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? fallback).trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function sanitizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key.trim()) continue;
    if (typeof value !== 'string') continue;
    if (out[key.trim()] !== undefined) continue;
    out[key.trim()] = value;
    if (Object.keys(out).length >= 30) break;
  }
  return out;
}

function sanitizeExtraBody(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input;
}

/**
 * Custom headers often carry gateway tokens, so they are encrypted at rest with
 * the same local key as API keys. A record written before this existed holds
 * plaintext: `decryptSecret` passes non-`v1:` values through unchanged, and the
 * values are encrypted the next time the provider is saved.
 */
export async function encryptProviderHeaders(
  headers: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value ? await encryptSecret(value) : '';
  }
  return out;
}

export async function decryptProviderHeaders(
  headers: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const plain = await decryptSecret(value);
    out[key] = plain ?? '';
  }
  return out;
}

function validate(input: AiProviderInput): AiProviderInput {
  const name = input.name?.trim();
  const baseUrl = input.baseUrl?.trim();
  const model = input.model?.trim();
  if (!name) throw new AppError('VALIDATION', 'Provider name is required.');
  if (!baseUrl) throw new AppError('VALIDATION', 'Base URL is required.');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new AppError('VALIDATION', 'Base URL must start with http:// or https://.');
  }
  if (!model) throw new AppError('VALIDATION', 'Model name is required.');
  if (!['openai', 'anthropic', 'google'].includes(input.type)) {
    throw new AppError('VALIDATION', 'Unsupported provider type.');
  }
  return {
    ...input,
    name: name.slice(0, 120),
    baseUrl,
    model: model.slice(0, 200),
  };
}

async function toPublic(provider: StoredProvider): Promise<AiProvider> {
  let hint: string | null = null;
  if (provider.apiKeyEnc) {
    const key = await decryptSecret(provider.apiKeyEnc);
    hint = maskSecret(key);
  }
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    chatPath: provider.chatPath,
    modelsPath: provider.modelsPath,
    model: provider.model,
    models: provider.models,
    hasApiKey: Boolean(provider.apiKeyEnc),
    apiKeyHint: hint,
    authHeader: provider.authHeader,
    authPrefix: provider.authPrefix,
    headers: await decryptProviderHeaders(provider.headers),
    extraBody: provider.extraBody,
    temperature: provider.temperature,
    maxTokens: provider.maxTokens,
    streaming: provider.streaming,
    isDefault: provider.isDefault,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export async function listProviders(): Promise<AiProvider[]> {
  const file = await store.read();
  return Promise.all(file.providers.map(toPublic));
}

export async function getStoredProvider(id: string): Promise<StoredProvider> {
  const file = await store.read();
  const provider = file.providers.find((item) => item.id === id);
  if (!provider) throw new AppError('PROVIDER_NOT_FOUND', 'AI provider not found.', 404);
  return provider;
}

export async function getProvider(id: string): Promise<AiProvider> {
  return toPublic(await getStoredProvider(id));
}

export async function getProviderApiKey(id: string): Promise<string | null> {
  const provider = await getStoredProvider(id);
  if (!provider.apiKeyEnc) return null;
  return decryptSecret(provider.apiKeyEnc);
}

export async function resolveProvider(
  id?: string | null,
): Promise<{ stored: StoredProvider; public: AiProvider; apiKey: string | null }> {
  let effectiveId = id ?? null;
  if (!effectiveId) {
    const settings = await getSettings();
    effectiveId = settings.defaultAiProviderId;
  }
  if (!effectiveId) {
    const file = await store.read();
    effectiveId =
      file.providers.find((item) => item.isDefault)?.id ?? file.providers[0]?.id ?? null;
  }
  if (!effectiveId) {
    throw new AppError('NO_AI_PROVIDER', 'No AI provider is configured. Add one in Settings.', 400);
  }
  const stored = await getStoredProvider(effectiveId);
  return {
    stored,
    public: await toPublic(stored),
    apiKey: stored.apiKeyEnc ? await decryptSecret(stored.apiKeyEnc) : null,
  };
}

export async function createProvider(input: AiProviderInput): Promise<AiProvider> {
  const clean = validate(input);
  const defaults = DEFAULTS[clean.type];
  const file = await store.read();
  if (file.providers.length >= 50) {
    throw new AppError('LIMIT_REACHED', 'You can configure at most 50 AI providers.', 400);
  }
  const timestamp = now();
  const stored: StoredProvider = {
    id: crypto.randomUUID(),
    name: clean.name,
    type: clean.type,
    baseUrl: normalizeBaseUrl(clean.baseUrl),
    chatPath: normalizePath(clean.chatPath, defaults.chatPath),
    modelsPath: normalizePath(clean.modelsPath, defaults.modelsPath),
    model: clean.model,
    models: [],
    apiKeyEnc:
      typeof clean.apiKey === 'string' && clean.apiKey.length > 0
        ? await encryptSecret(clean.apiKey)
        : null,
    authHeader: (clean.authHeader ?? defaults.authHeader).trim(),
    authPrefix: clean.authPrefix ?? defaults.authPrefix,
    headers: await encryptProviderHeaders(sanitizeHeaders(clean.headers)),
    extraBody: sanitizeExtraBody(clean.extraBody),
    temperature: clampNumber(clean.temperature, 0, 2, 0.2),
    maxTokens: Math.trunc(clampNumber(clean.maxTokens, 16, 128_000, 4096)),
    streaming: clean.streaming !== false,
    isDefault: Boolean(clean.isDefault) || file.providers.length === 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await store.update((current) => ({
    providers: [
      ...current.providers.map((provider) =>
        stored.isDefault ? { ...provider, isDefault: false } : provider,
      ),
      stored,
    ],
  }));

  if (stored.isDefault) await setDefaultAiProvider(stored.id);
  return toPublic(stored);
}

export async function updateProvider(id: string, input: AiProviderInput): Promise<AiProvider> {
  const clean = validate(input);
  const defaults = DEFAULTS[clean.type];
  let updated: StoredProvider | null = null;

  await store.update(async (current) => {
    const index = current.providers.findIndex((item) => item.id === id);
    if (index < 0) throw new AppError('PROVIDER_NOT_FOUND', 'AI provider not found.', 404);
    const previous = current.providers[index];

    let apiKeyEnc = previous.apiKeyEnc ?? null;
    if (clean.clearApiKey) apiKeyEnc = null;
    else if (typeof clean.apiKey === 'string' && clean.apiKey.length > 0) {
      apiKeyEnc = await encryptSecret(clean.apiKey);
    }

    updated = {
      ...previous,
      name: clean.name,
      type: clean.type,
      baseUrl: normalizeBaseUrl(clean.baseUrl),
      chatPath: normalizePath(clean.chatPath, defaults.chatPath),
      modelsPath: normalizePath(clean.modelsPath, defaults.modelsPath),
      model: clean.model,
      apiKeyEnc,
      authHeader: (clean.authHeader ?? defaults.authHeader).trim(),
      authPrefix: clean.authPrefix ?? defaults.authPrefix,
      headers: await encryptProviderHeaders(sanitizeHeaders(clean.headers)),
      extraBody: sanitizeExtraBody(clean.extraBody),
      temperature: clampNumber(clean.temperature, 0, 2, previous.temperature),
      maxTokens: Math.trunc(clampNumber(clean.maxTokens, 16, 128_000, previous.maxTokens)),
      streaming: clean.streaming !== false,
      isDefault: clean.isDefault ?? previous.isDefault,
      updatedAt: now(),
    };

    let providers = [...current.providers];
    providers[index] = updated;
    if (updated.isDefault) {
      providers = providers.map((provider) =>
        provider.id === id ? provider : { ...provider, isDefault: false },
      );
    }
    if (!providers.some((provider) => provider.isDefault) && providers.length > 0) {
      providers = providers.map((provider, i) =>
        i === 0 ? { ...provider, isDefault: true } : provider,
      );
      updated = providers[0];
    }
    return { providers };
  });

  if (!updated) throw new AppError('PROVIDER_NOT_FOUND', 'AI provider not found.', 404);
  const result = updated as StoredProvider;
  if (result.isDefault) await setDefaultAiProvider(result.id);
  return toPublic(result);
}

export async function deleteProvider(id: string): Promise<void> {
  let nextDefault: string | null = null;
  await store.update((current) => {
    const exists = current.providers.some((provider) => provider.id === id);
    if (!exists) throw new AppError('PROVIDER_NOT_FOUND', 'AI provider not found.', 404);
    const providers = current.providers.filter((provider) => provider.id !== id);
    if (providers.length > 0 && !providers.some((provider) => provider.isDefault)) {
      providers[0] = { ...providers[0], isDefault: true };
    }
    nextDefault = providers.find((provider) => provider.isDefault)?.id ?? null;
    return { providers };
  });
  const settings = await getSettings();
  if (!settings.defaultAiProviderId || settings.defaultAiProviderId === id) {
    await setDefaultAiProvider(nextDefault);
  }
}

export async function setDefaultProvider(id: string): Promise<AiProvider> {
  const provider = await getStoredProvider(id);
  await store.update((current) => ({
    providers: current.providers.map((item) => ({
      ...item,
      isDefault: item.id === id,
    })),
  }));
  await setDefaultAiProvider(id);
  return toPublic({ ...provider, isDefault: true });
}

export async function setProviderModels(id: string, models: string[]): Promise<void> {
  const unique = Array.from(new Set(models.filter(Boolean))).slice(0, 500);
  await store.update((current) => ({
    providers: current.providers.map((provider) =>
      provider.id === id ? { ...provider, models: unique, updatedAt: now() } : provider,
    ),
  }));
}

function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export type { StoredProvider };
