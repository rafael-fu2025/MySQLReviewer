import { Router } from 'express';
import { z } from 'zod';
import type { AiChatRequest } from '../../shared/types';
import {
  createProvider,
  deleteProvider,
  getProvider,
  getProviderApiKey,
  listProviders,
  resolveProvider,
  setDefaultProvider,
  setProviderModels,
  updateProvider,
} from '../store/providers';
import { listModels, testProvider } from '../ai';
import { runAiChat } from '../ai/analyze';
import { openSse } from '../sse';
import { asyncHandler, param, parseBody } from './util';

const ProviderSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['openai', 'anthropic', 'google']),
  baseUrl: z.string().url().max(1_000),
  chatPath: z.string().max(1_000).optional(),
  modelsPath: z.string().max(1_000).optional(),
  model: z.string().min(1).max(200),
  apiKey: z.string().max(8_000).optional(),
  clearApiKey: z.boolean().optional(),
  authHeader: z.string().max(100).optional(),
  authPrefix: z.string().max(100).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(16).max(128_000).optional(),
  streaming: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

const ChatSchema = z.object({
  providerId: z.string().min(1).max(200),
  model: z.string().max(200).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(50_000),
      }),
    )
    .min(1)
    .max(50),
  context: z
    .object({
      sql: z.string().max(200_000).optional(),
      database: z.string().max(200).nullable().optional(),
      profileId: z.string().max(200).nullable().optional(),
      includeSchema: z.boolean().optional(),
    })
    .optional(),
});

export const aiRouter = Router();

aiRouter.get(
  '/providers',
  asyncHandler(async (_req, res) => {
    res.json({ data: await listProviders() });
  }),
);

aiRouter.post(
  '/providers',
  asyncHandler(async (req, res) => {
    const body = parseBody(ProviderSchema, req);
    res.status(201).json({ data: await createProvider(body) });
  }),
);

aiRouter.put(
  '/providers/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(ProviderSchema, req);
    res.json({ data: await updateProvider(param(req, 'id'), body) });
  }),
);

aiRouter.delete(
  '/providers/:id',
  asyncHandler(async (req, res) => {
    await deleteProvider(param(req, 'id'));
    res.json({ data: { deleted: true } });
  }),
);

aiRouter.post(
  '/providers/:id/default',
  asyncHandler(async (req, res) => {
    res.json({ data: await setDefaultProvider(param(req, 'id')) });
  }),
);

aiRouter.post(
  '/providers/:id/test',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const provider = await getProvider(id);
    const apiKey = await getProviderApiKey(id);
    const result = await testProvider(provider, apiKey);
    if (result.ok && result.models.length > 0) {
      await setProviderModels(id, result.models);
    }
    res.json({ data: result });
  }),
);

aiRouter.get(
  '/providers/:id/models',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const provider = await getProvider(id);
    const apiKey = await getProviderApiKey(id);
    const models = await listModels(provider, apiKey);
    if (models.length > 0) await setProviderModels(id, models);
    res.json({ data: { models } });
  }),
);

aiRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const body = parseBody(ChatSchema, req) as AiChatRequest;
    const resolved = await resolveProvider(body.providerId);
    const provider = body.model?.trim()
      ? { ...resolved.public, model: body.model.trim() }
      : resolved.public;

    const sse = openSse(req, res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    sse.send('meta', {
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      streaming: provider.streaming,
    });
    try {
      const result = await runAiChat(
        body,
        provider,
        resolved.apiKey,
        (text) => sse.send('delta', { text }),
        controller.signal,
      );
      sse.send('result', { text: result.text, usage: result.usage });
      sse.send('done', {});
    } catch (error) {
      sse.send('error', {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code ?? 'AI_ERROR',
      });
    } finally {
      sse.close();
    }
  }),
);
