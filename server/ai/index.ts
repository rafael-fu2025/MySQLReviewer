import type { AiProvider, AiProviderTestResult } from '../../shared/types';
import { AppError } from '../errors';
import { completeAnthropic, listAnthropicModels, streamAnthropic } from './anthropic';
import { completeGoogle, listGoogleModels, streamGoogle } from './google';
import { completeOpenAi, listOpenAiModels, streamOpenAi } from './openai';
import {
  extractJsonPayload,
  type ChatMessage,
  type ChatOptions,
  type CompleteResult,
  type StreamHandlers,
} from './http';

export type {
  ChatMessage,
  ChatOptions,
  ChatToolCallSpec,
  ChatToolDefinition,
  CompleteResult,
  StreamHandlers,
  ChatUsage,
} from './http';

/**
 * Provider calls are the one place in the app where a user action costs real
 * money and holds an open socket for minutes. Both a rate limit and a
 * concurrency cap are applied here so every AI route (review, practice,
 * audit, chat) is covered by one policy.
 */
const MAX_CONCURRENT_AI_CALLS = 4;
const MAX_QUEUED_AI_CALLS = 8;
const AI_CALLS_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

class AiConcurrency {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_AI_CALLS) {
      if (this.queue.length >= MAX_QUEUED_AI_CALLS) {
        throw new AppError('AI_BUSY', 'The AI provider is busy. Try again in a moment.', 429);
      }
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const concurrency = new AiConcurrency();
const callTimestamps: number[] = [];

function checkAiRateLimit(): void {
  const now = Date.now();
  while (callTimestamps.length > 0 && now - callTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    callTimestamps.shift();
  }
  if (callTimestamps.length >= AI_CALLS_PER_MINUTE) {
    throw new AppError('AI_RATE_LIMIT', 'Too many AI requests. Try again in a moment.', 429);
  }
  callTimestamps.push(now);
}

/** Runs one provider call under the rate limit and the concurrency cap. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  checkAiRateLimit();
  return concurrency.run(fn);
}

/** Test hook: clears the rate-limit window and the queued calls. */
export function resetAiLimits(): void {
  callTimestamps.length = 0;
}

function dispatchComplete(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<CompleteResult> {
  if (provider.type === 'anthropic') {
    return completeAnthropic(provider, apiKey, messages, options);
  }
  if (provider.type === 'google') {
    return completeGoogle(provider, apiKey, messages, options);
  }
  return completeOpenAi(provider, apiKey, messages, options);
}

function dispatchStream(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options: ChatOptions,
): Promise<CompleteResult> {
  if (provider.type === 'anthropic') {
    return streamAnthropic(provider, apiKey, messages, handlers, options);
  }
  if (provider.type === 'google') {
    return streamGoogle(provider, apiKey, messages, handlers, options);
  }
  return streamOpenAi(provider, apiKey, messages, handlers, options);
}

export async function complete(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<CompleteResult> {
  const result = await guarded(async () => {
    return dispatchComplete(provider, apiKey, messages, options);
  });
  // Recovering the JSON object locally keeps a slightly malformed provider
  // answer from triggering a second billable "repair" round trip.
  return { ...result, text: extractJsonPayload(result.text) };
}

export async function stream(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options: ChatOptions = {},
): Promise<CompleteResult> {
  const result = await guarded(async () => {
    return dispatchStream(provider, apiKey, messages, handlers, options);
  });
  return { ...result, text: extractJsonPayload(result.text) };
}

/**
 * The agent-loop entry points. They carry `tools` and skip the JSON-recovery
 * pass: an agent answer is prose, and recovering a JSON object out of it would
 * cut the answer down to a brace fragment.
 */
export async function completeWithTools(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return guarded(async () => dispatchComplete(provider, apiKey, messages, options));
}

export async function streamWithTools(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return guarded(async () => dispatchStream(provider, apiKey, messages, handlers, options));
}

export async function listModels(provider: AiProvider, apiKey: string | null): Promise<string[]> {
  return guarded(async () => {
    if (provider.type === 'anthropic') return listAnthropicModels(provider, apiKey);
    if (provider.type === 'google') return listGoogleModels(provider, apiKey);
    return listOpenAiModels(provider, apiKey);
  });
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
