import type { AiProvider } from '../../shared/types';
import {
  errorFromResponse,
  joinUrl,
  providerHeaders,
  readSse,
  withTimeout,
  type ChatMessage,
  type ChatOptions,
  type CompleteResult,
  type StreamHandlers,
} from './http';

interface AnthropicResponse {
  content?: { type?: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function messagesUrl(provider: AiProvider): string {
  return joinUrl(provider.baseUrl, provider.chatPath || '/v1/messages');
}

function buildBody(
  provider: AiProvider,
  messages: ChatMessage[],
  stream: boolean,
  options: ChatOptions,
): Record<string, unknown> {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const conversation = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }));
  return {
    model: provider.model,
    max_tokens: options.maxTokens ?? provider.maxTokens,
    temperature: options.temperature ?? provider.temperature,
    ...(system ? { system } : {}),
    messages: conversation.length ? conversation : [{ role: 'user', content: 'Continue.' }],
    stream,
    ...provider.extraBody,
  };
}

function headers(provider: AiProvider, apiKey: string | null): Record<string, string> {
  return providerHeaders(provider, apiKey, {
    'anthropic-version': '2023-06-01',
  });
}

function usageFrom(data: AnthropicResponse): CompleteResult['usage'] {
  if (!data.usage) return null;
  return {
    inputTokens: data.usage.input_tokens ?? null,
    outputTokens: data.usage.output_tokens ?? null,
    totalTokens:
      data.usage.input_tokens != null && data.usage.output_tokens != null
        ? data.usage.input_tokens + data.usage.output_tokens
        : null,
  };
}

export async function completeAnthropic(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return withTimeout(
    async (signal) => {
      const response = await fetch(messagesUrl(provider), {
        method: 'POST',
        headers: headers(provider, apiKey),
        body: JSON.stringify(buildBody(provider, messages, false, options)),
        signal,
      });
      if (!response.ok) await errorFromResponse(response, provider.name);
      const data = (await response.json()) as AnthropicResponse;
      const text = (data.content ?? [])
        .filter((block) => block.type === 'text' || !block.type)
        .map((block) => block.text ?? '')
        .join('');
      return { text, usage: usageFrom(data) };
    },
    180_000,
    options.signal,
  );
}

export async function streamAnthropic(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return withTimeout(
    async (signal) => {
      const response = await fetch(messagesUrl(provider), {
        method: 'POST',
        headers: headers(provider, apiKey),
        body: JSON.stringify(buildBody(provider, messages, true, options)),
        signal,
      });
      if (!response.ok) await errorFromResponse(response, provider.name);

      let text = '';
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      await readSse(response, (_event, data) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(payload.type ?? '');
        if (type === 'content_block_delta') {
          const delta = payload.delta as { text?: string } | undefined;
          if (delta?.text) {
            text += delta.text;
            handlers.onDelta(delta.text);
          }
        } else if (type === 'message_start') {
          const message = payload.message as { usage?: { input_tokens?: number } } | undefined;
          inputTokens = message?.usage?.input_tokens ?? inputTokens;
        } else if (type === 'message_delta') {
          const usage = payload.usage as { output_tokens?: number } | undefined;
          outputTokens = usage?.output_tokens ?? outputTokens;
        }
      });
      const usage =
        inputTokens != null || outputTokens != null
          ? {
              inputTokens,
              outputTokens,
              totalTokens:
                inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
            }
          : null;
      return { text, usage };
    },
    180_000,
    options.signal,
  );
}

export async function listAnthropicModels(
  provider: AiProvider,
  apiKey: string | null,
): Promise<string[]> {
  return withTimeout(async (signal) => {
    const url = joinUrl(provider.baseUrl, provider.modelsPath || '/v1/models');
    const response = await fetch(url, {
      method: 'GET',
      headers: headers(provider, apiKey),
      signal,
    });
    if (!response.ok) await errorFromResponse(response, provider.name);
    const data = (await response.json()) as { data?: { id?: string }[] };
    return Array.from(
      new Set((data.data ?? []).map((item) => item.id ?? '').filter(Boolean)),
    ).slice(0, 500);
  }, 30_000);
}
