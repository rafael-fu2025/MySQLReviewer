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

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string };
}

function keyQuery(apiKey: string | null): string {
  return apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
}

function buildContents(messages: ChatMessage[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[];
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: message.content }],
    }));
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: 'Continue.' }] }],
  };
}

function requestBody(
  provider: AiProvider,
  messages: ChatMessage[],
  options: ChatOptions,
): Record<string, unknown> {
  return {
    ...buildContents(messages),
    generationConfig: {
      temperature: options.temperature ?? provider.temperature,
      maxOutputTokens: options.maxTokens ?? provider.maxTokens,
    },
    ...provider.extraBody,
  };
}

function textFromResponse(data: GeminiResponse): string {
  return (data.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');
}

function usageFrom(data: GeminiResponse): CompleteResult['usage'] {
  if (!data.usageMetadata) return null;
  return {
    inputTokens: data.usageMetadata.promptTokenCount ?? null,
    outputTokens: data.usageMetadata.candidatesTokenCount ?? null,
    totalTokens: data.usageMetadata.totalTokenCount ?? null,
  };
}

function url(
  provider: AiProvider,
  model: string,
  method: ':generateContent' | ':streamGenerateContent',
  apiKey: string | null,
): string {
  const base = joinUrl(provider.baseUrl, `models/${encodeURIComponent(model)}${method}`);
  return method === ':streamGenerateContent'
    ? `${base}${apiKey ? '?' : '?'}alt=sse${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`
    : `${base}${keyQuery(apiKey)}`;
}

export async function completeGoogle(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return withTimeout(
    async (signal) => {
      const response = await fetch(url(provider, provider.model, ':generateContent', apiKey), {
        method: 'POST',
        headers: providerHeaders(provider, null),
        body: JSON.stringify(requestBody(provider, messages, options)),
        signal,
      });
      if (!response.ok) await errorFromResponse(response, provider.name);
      const data = (await response.json()) as GeminiResponse;
      return { text: textFromResponse(data), usage: usageFrom(data) };
    },
    180_000,
    options.signal,
  );
}

export async function streamGoogle(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return withTimeout(
    async (signal) => {
      const response = await fetch(
        url(provider, provider.model, ':streamGenerateContent', apiKey),
        {
          method: 'POST',
          headers: providerHeaders(provider, null, { Accept: 'text/event-stream' }),
          body: JSON.stringify(requestBody(provider, messages, options)),
          signal,
        },
      );
      if (!response.ok) await errorFromResponse(response, provider.name);

      let text = '';
      let usage: CompleteResult['usage'] = null;
      await readSse(response, (_event, data) => {
        let payload: GeminiResponse;
        try {
          payload = JSON.parse(data) as GeminiResponse;
        } catch {
          return;
        }
        const delta = textFromResponse(payload);
        if (delta) {
          text += delta;
          handlers.onDelta(delta);
        }
        usage = usageFrom(payload) ?? usage;
      });
      return { text, usage };
    },
    180_000,
    options.signal,
  );
}

export async function listGoogleModels(
  provider: AiProvider,
  apiKey: string | null,
): Promise<string[]> {
  return withTimeout(async (signal) => {
    const base = joinUrl(provider.baseUrl, provider.modelsPath || '/models');
    const urlWithKey = `${base}${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    const response = await fetch(urlWithKey, {
      method: 'GET',
      headers: providerHeaders(provider, null),
      signal,
    });
    if (!response.ok) await errorFromResponse(response, provider.name);
    const data = (await response.json()) as {
      models?: {
        name?: string;
        supportedGenerationMethods?: string[];
      }[];
    };
    return Array.from(
      new Set(
        (data.models ?? [])
          .filter(
            (model) =>
              !model.supportedGenerationMethods ||
              model.supportedGenerationMethods.includes('generateContent'),
          )
          .map((model) => (model.name ?? '').replace(/^models\//, ''))
          .filter(Boolean),
      ),
    ).slice(0, 500);
  }, 30_000);
}
