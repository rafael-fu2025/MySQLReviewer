import type { AiProvider } from '../../shared/types';
import { AppError } from '../errors';
import {
  errorFromResponse,
  joinUrl,
  providerHeaders,
  providerSecrets,
  readBoundedJson,
  readSse,
  withTimeout,
  type ChatMessage,
  type ChatOptions,
  type ChatToolCallSpec,
  type CompleteResult,
  type StreamHandlers,
} from './http';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: unknown };
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

/**
 * The Google API key travels in the `x-goog-api-key` header, never in the
 * query string: query strings end up in proxy logs and provider access logs.
 */
function keyHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { 'x-goog-api-key': apiKey } : {};
}

/**
 * The model name is interpolated into the request path. It must be a single
 * plain path segment: percent-encoding does not stop a server from decoding
 * `..` and walking out of the intended path.
 */
function safeModelSegment(model: string): string {
  const value = model.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) || value.includes('..')) {
    throw new AppError('VALIDATION', 'The provider model name is not a valid path segment.');
  }
  return value;
}

/**
 * Projects the normalized message list onto Gemini's content shape. Gemini has
 * no tool role: a model tool call is a `functionCall` part in a model message,
 * and the result is a `functionResponse` part in a user message. Calls are
 * matched to responses by tool name, not by id.
 */
function buildContents(messages: ChatMessage[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: 'user' | 'model'; parts: GeminiPart[] }[];
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents: { role: 'user' | 'model'; parts: GeminiPart[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.name ?? 'tool',
              response: safeJson(message.content),
            },
          },
        ],
      });
      continue;
    }
    const parts: GeminiPart[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: safeJson(call.arguments) } });
    }
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: 'Continue.' }] }],
  };
}

/** Parses JSON text, falling back to a wrapping object for non-JSON strings. */
function safeJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : { result: parsed };
  } catch {
    return { result: text };
  }
}

function requestBody(
  provider: AiProvider,
  messages: ChatMessage[],
  options: ChatOptions,
): Record<string, unknown> {
  return {
    ...buildContents(messages),
    ...(options.tools?.length
      ? {
          tools: [
            {
              functionDeclarations: options.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            },
          ],
        }
      : {}),
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

/** Collects the `functionCall` parts of a response chunk or final payload. */
function toolCallsFromResponse(data: GeminiResponse): ChatToolCallSpec[] {
  return (data.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => part.functionCall?.name)
    .map((part, index) => ({
      id: `call_${index}`,
      name: part.functionCall?.name ?? '',
      arguments: JSON.stringify(part.functionCall?.args ?? {}),
    }));
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
): string {
  const base = joinUrl(provider.baseUrl, `models/${safeModelSegment(model)}${method}`);
  return method === ':streamGenerateContent' ? `${base}?alt=sse` : base;
}

export async function completeGoogle(
  provider: AiProvider,
  apiKey: string | null,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<CompleteResult> {
  return withTimeout(
    async (signal) => {
      const response = await fetch(url(provider, provider.model, ':generateContent'), {
        method: 'POST',
        headers: providerHeaders(provider, null, keyHeaders(apiKey)),
        body: JSON.stringify(requestBody(provider, messages, options)),
        signal,
      });
      if (!response.ok)
        await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));
      const data = await readBoundedJson<GeminiResponse>(response);
      const toolCalls = toolCallsFromResponse(data);
      return {
        text: textFromResponse(data),
        usage: usageFrom(data),
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
        toolCalls,
      };
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
      const response = await fetch(url(provider, provider.model, ':streamGenerateContent'), {
        method: 'POST',
        headers: providerHeaders(provider, null, {
          Accept: 'text/event-stream',
          ...keyHeaders(apiKey),
        }),
        body: JSON.stringify(requestBody(provider, messages, options)),
        signal,
      });
      if (!response.ok)
        await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));

      let text = '';
      let usage: CompleteResult['usage'] = null;
      const toolCalls: ChatToolCallSpec[] = [];
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
        // A functionCall arrives whole inside one chunk; there is nothing to
        // stitch, so calls are appended as they appear.
        for (const call of toolCallsFromResponse(payload)) toolCalls.push(call);
        usage = usageFrom(payload) ?? usage;
      });
      return {
        text,
        usage,
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
        toolCalls,
      };
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
    const response = await fetch(base, {
      method: 'GET',
      headers: providerHeaders(provider, null, keyHeaders(apiKey)),
      signal,
    });
    if (!response.ok)
      await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));
    const data = await readBoundedJson<{
      models?: {
        name?: string;
        supportedGenerationMethods?: string[];
      }[];
    }>(response);
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
