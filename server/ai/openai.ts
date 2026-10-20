import type { AiProvider } from '../../shared/types';
import {
  emptyUsage,
  errorFromResponse,
  joinUrl,
  normalizeOpenAiContent,
  providerHeaders,
  readSse,
  withTimeout,
  type ChatMessage,
  type ChatOptions,
  type CompleteResult,
  type StreamHandlers,
} from './http';

interface OpenAiChoice {
  message?: { content?: unknown };
  delta?: { content?: unknown };
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

function usageFrom(response: OpenAiResponse): CompleteResult['usage'] {
  if (!response.usage) return null;
  return {
    inputTokens: response.usage.prompt_tokens ?? null,
    outputTokens: response.usage.completion_tokens ?? null,
    totalTokens: response.usage.total_tokens ?? null,
  };
}

function chatUrl(provider: AiProvider): string {
  return joinUrl(provider.baseUrl, provider.chatPath || '/chat/completions');
}

function body(
  provider: AiProvider,
  messages: ChatMessage[],
  stream: boolean,
  options: ChatOptions,
): Record<string, unknown> {
  return {
    model: provider.model,
    messages,
    temperature: options.temperature ?? provider.temperature,
    max_tokens: options.maxTokens ?? provider.maxTokens,
    stream,
    ...provider.extraBody,
  };
}

export async function completeOpenAi(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return withTimeout(
    async (signal) => {
      const response = await fetch(chatUrl(provider), {
        method: 'POST',
        headers: providerHeaders(provider, apiKey),
        body: JSON.stringify(body(provider, messages, false, options)),
        signal,
      });
      if (!response.ok) await errorFromResponse(response, provider.name);
      const data = (await response.json()) as OpenAiResponse;
      const text = normalizeOpenAiContent(data.choices?.[0]?.message?.content);
      return { text, usage: usageFrom(data) };
    },
    180_000,
    options.signal,
  );
}

export async function streamOpenAi(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return withTimeout(
    async (signal) => {
      const response = await fetch(chatUrl(provider), {
        method: 'POST',
        headers: providerHeaders(provider, apiKey, { Accept: 'text/event-stream' }),
        body: JSON.stringify(body(provider, messages, true, options)),
        signal,
      });
      if (!response.ok) await errorFromResponse(response, provider.name);

      let text = '';
      let usage = emptyUsage();
      let sawUsage = false;
      await readSse(response, (_event, data) => {
        if (data === '[DONE]') return;
        let payload: OpenAiResponse;
        try {
          payload = JSON.parse(data) as OpenAiResponse;
        } catch {
          return;
        }
        const delta = normalizeOpenAiContent(payload.choices?.[0]?.delta?.content);
        if (delta) {
          text += delta;
          handlers.onDelta(delta);
        }
        if (payload.usage) {
          usage = usageFrom(payload) ?? usage;
          sawUsage = true;
        }
      });
      return { text, usage: sawUsage ? usage : null };
    },
    180_000,
    options.signal,
  );
}

export async function listOpenAiModels(
  provider: AiProvider,
  apiKey: string | null,
): Promise<string[]> {
  return withTimeout(
    async (signal) => {
      const url = joinUrl(provider.baseUrl, provider.modelsPath || '/models');
      const response = await fetch(url, {
        method: 'GET',
        headers: providerHeaders(provider, apiKey),
        signal,
      });
      if (!response.ok) await errorFromResponse(response, provider.name);
      const data = (await response.json()) as {
        data?: { id?: string }[];
        models?: { id?: string; name?: string }[];
      };
      const models = [
        ...(data.data ?? []).map((item) => item.id ?? ''),
        ...(data.models ?? []).map((item) => item.id ?? item.name ?? ''),
      ].filter(Boolean);
      return Array.from(new Set(models)).slice(0, 500);
    },
    30_000,
  );
}
