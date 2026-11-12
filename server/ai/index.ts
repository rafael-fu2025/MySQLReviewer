import type { AiProvider, AiProviderTestResult } from '../../shared/types';
import { AppError } from '../errors';
import { currentRuntimeUserId } from '../runtime-context';
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
/** One account cannot occupy every active provider slot or queue position. */
const MAX_CONCURRENT_AI_CALLS_PER_USER = 2;
const MAX_QUEUED_AI_CALLS_PER_USER = 4;
const AI_CALLS_PER_MINUTE = 60;
const AI_CALLS_PER_USER_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

class AiConcurrency {
  private active = 0;
  private readonly activeByUser = new Map<string, number>();
  private readonly queue: Array<{ userId: string | null; start: () => void }> = [];

  async run<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
    await this.acquire(userId);
    try {
      return await fn();
    } finally {
      this.release(userId);
    }
  }

  private async acquire(userId: string | null): Promise<void> {
    if (this.queue.length === 0 && this.canStart(userId)) {
      this.reserve(userId);
      return;
    }
    if (
      this.queue.length >= MAX_QUEUED_AI_CALLS ||
      (userId !== null &&
        this.queue.filter((entry) => entry.userId === userId).length >=
          MAX_QUEUED_AI_CALLS_PER_USER)
    ) {
      throw new AppError('AI_BUSY', 'The AI provider is busy. Try again in a moment.', 429);
    }
    await new Promise<void>((resolve) => {
      this.queue.push({ userId, start: resolve });
      this.drain();
    });
  }

  private canStart(userId: string | null): boolean {
    return (
      this.active < MAX_CONCURRENT_AI_CALLS &&
      (userId === null || (this.activeByUser.get(userId) ?? 0) < MAX_CONCURRENT_AI_CALLS_PER_USER)
    );
  }

  private reserve(userId: string | null): void {
    this.active += 1;
    if (userId !== null) {
      this.activeByUser.set(userId, (this.activeByUser.get(userId) ?? 0) + 1);
    }
  }

  private release(userId: string | null): void {
    this.active = Math.max(0, this.active - 1);
    if (userId !== null) {
      const left = (this.activeByUser.get(userId) ?? 1) - 1;
      if (left <= 0) this.activeByUser.delete(userId);
      else this.activeByUser.set(userId, left);
    }
    this.drain();
  }

  /** Starts the oldest eligible owner; blocked owners do not head-of-line block others. */
  private drain(): void {
    while (this.active < MAX_CONCURRENT_AI_CALLS) {
      const index = this.queue.findIndex((entry) => this.canStart(entry.userId));
      if (index < 0) return;
      const [next] = this.queue.splice(index, 1);
      this.reserve(next.userId);
      next.start();
    }
  }
}

const concurrency = new AiConcurrency();
const callTimestamps: number[] = [];
const callTimestampsByUser = new Map<string, number[]>();

function pruneWindow(timestamps: number[], now: number): void {
  while (timestamps.length > 0 && now - timestamps[0] > RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }
}

function checkAiRateLimit(userId: string | null): void {
  const now = Date.now();
  pruneWindow(callTimestamps, now);
  if (callTimestamps.length >= AI_CALLS_PER_MINUTE) {
    throw new AppError('AI_RATE_LIMIT', 'Too many AI requests. Try again in a moment.', 429);
  }
  if (userId !== null) {
    const mine = callTimestampsByUser.get(userId) ?? [];
    pruneWindow(mine, now);
    if (mine.length >= AI_CALLS_PER_USER_PER_MINUTE) {
      throw new AppError(
        'AI_RATE_LIMIT',
        'This account has sent too many AI requests. Try again in a moment.',
        429,
      );
    }
    mine.push(now);
    callTimestampsByUser.set(userId, mine);
  }
  callTimestamps.push(now);
}

/** Runs one provider call under per-user fairness and installation-wide caps. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  const userId = currentRuntimeUserId();
  checkAiRateLimit(userId);
  return concurrency.run(userId, fn);
}

/** Test hook: clears the rate-limit window and the queued calls. */
export function resetAiLimits(): void {
  callTimestamps.length = 0;
  callTimestampsByUser.clear();
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
