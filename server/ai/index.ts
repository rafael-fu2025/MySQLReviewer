import type { AiProvider, AiProviderTestResult } from '../../shared/types';
import { AppError } from '../errors';
import {
  completeAnthropic,
  listAnthropicModels,
  streamAnthropic,
} from './anthropic';
import { completeGoogle, listGoogleModels, streamGoogle } from './google';
import { completeOpenAi, listOpenAiModels, streamOpenAi } from './openai';
import type {
  ChatMessage,
  ChatOptions,
  CompleteResult,
  StreamHandlers,
} from './http';

export type { ChatMessage, ChatOptions, CompleteResult, StreamHandlers, ChatUsage } from './http';

export async function complete(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<CompleteResult> {
  if (provider.type === 'anthropic') {
    return completeAnthropic(provider, apiKey, messages, options);
  }
  if (provider.type === 'google') {
    return completeGoogle(provider, apiKey, messages, options);
  }
  return completeOpenAi(provider, apiKey, messages, options);
}

export async function stream(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options: ChatOptions = {},
): Promise<CompleteResult> {
  if (provider.type === 'anthropic') {
    return streamAnthropic(provider, apiKey, messages, handlers, options);
  }
  if (provider.type === 'google') {
    return streamGoogle(provider, apiKey, messages, handlers, options);
  }
  return streamOpenAi(provider, apiKey, messages, handlers, options);
}

export async function listModels(
  provider: AiProvider,
  apiKey: string | null,
): Promise<string[]> {
  if (provider.type === 'anthropic') return listAnthropicModels(provider, apiKey);
  if (provider.type === 'google') return listGoogleModels(provider, apiKey);
  return listOpenAiModels(provider, apiKey);
}

export async function testProvider(
  provider: AiProvider,
  apiKey: string | null,
): Promise<AiProviderTestResult> {
  const started = Date.now();
  let models: string[] = [];
  let listingError: unknown = null;

  try {
    models = await listModels(provider, apiKey);
  } catch (error) {
    listingError = error;
    if (error instanceof AppError && error.code === 'AI_AUTH') {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error.message,
        models: [],
        detectedModel: null,
      };
    }
  }

  if (models.length > 0) {
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
      models,
      detectedModel: provider.model || models[0],
    };
  }

  try {
    const result = await complete(
      provider,
      apiKey,
      [{ role: 'user', content: 'Reply with the single word OK.' }],
      { temperature: 0, maxTokens: 8 },
    );
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `Chat completion succeeded${result.text ? ` (${result.text.slice(0, 40)})` : ''}.`,
      models: [],
      detectedModel: provider.model || null,
    };
  } catch (error) {
    const message =
      error instanceof AppError
        ? error.message
        : listingError instanceof Error
          ? listingError.message
          : String(error);
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message,
      models: [],
      detectedModel: null,
    };
  }
}
