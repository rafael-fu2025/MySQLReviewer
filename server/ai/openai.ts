import type { AiProvider } from '../../shared/types';
import {
  emptyUsage,
  errorFromResponse,
  joinUrl,
  normalizeOpenAiContent,
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

interface OpenAiToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChoice {
  message?: { content?: unknown; tool_calls?: OpenAiToolCall[] };
  delta?: { content?: unknown; tool_calls?: OpenAiToolCall[] };
  finish_reason?: string | null;
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

/**
 * Projects the normalized message list onto the OpenAI wire shape: an
 * assistant message that issued tool calls carries them as `tool_calls`, and
 * each `tool` message is bound to its call with `tool_call_id`.
 */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content ?? '',
      };
    }
    return { role: message.role, content: message.content ?? '' };
  });
}

function body(
  provider: AiProvider,
  messages: ChatMessage[],
  stream: boolean,
  options: ChatOptions,
): Record<string, unknown> {
  return {
    model: provider.model,
    messages: toWireMessages(messages),
    temperature: options.temperature ?? provider.temperature,
    max_tokens: options.maxTokens ?? provider.maxTokens,
    stream,
    ...(options.tools?.length
      ? {
          tools: options.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
    ...provider.extraBody,
  };
}

/** Parses the tool calls of a finished (non-streamed) choice. */
function toolCallsFromMessage(calls: OpenAiToolCall[] | undefined): ChatToolCallSpec[] {
  return (calls ?? [])
    .filter((call) => call.function?.name)
    .map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
    }));
}

/**
 * Stitches streamed tool-call fragments together.
 *
 * OpenAI fragments a tool call across chunks — the first chunk of a call
 * carries `id` and the function name, later chunks append pieces of the
 * arguments string. Fragments are keyed by `index` and merged in arrival
 * order, so an id or name arriving late still lands on the right call.
 */
class OpenAiToolCallBuffer {
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();

  add(fragments: OpenAiToolCall[] | undefined): void {
    for (const fragment of fragments ?? []) {
      const index = fragment.index ?? this.calls.size;
      const current = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (fragment.id) current.id = fragment.id;
      if (fragment.function?.name) current.name = fragment.function.name;
      if (fragment.function?.arguments) current.arguments += fragment.function.arguments;
      this.calls.set(index, current);
    }
  }

  list(): ChatToolCallSpec[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments || '{}',
      }));
  }
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
      if (!response.ok)
        await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));
      const data = await readBoundedJson<OpenAiResponse>(response);
      const choice = data.choices?.[0];
      const toolCalls = toolCallsFromMessage(choice?.message?.tool_calls);
      return {
        text: normalizeOpenAiContent(choice?.message?.content),
        usage: usageFrom(data),
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
        toolCalls,
      };
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
      if (!response.ok)
        await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));

      let text = '';
      let usage = emptyUsage();
      let sawUsage = false;
      let finishReason: string | null = null;
      const toolBuffer = new OpenAiToolCallBuffer();
      await readSse(response, (_event, data) => {
        if (data === '[DONE]') return;
        let payload: OpenAiResponse;
        try {
          payload = JSON.parse(data) as OpenAiResponse;
        } catch {
          return;
        }
        const choice = payload.choices?.[0];
        const delta = choice?.delta;
        const content = normalizeOpenAiContent(delta?.content);
        if (content) {
          text += content;
          handlers.onDelta(content);
        }
        if (delta?.tool_calls?.length) toolBuffer.add(delta.tool_calls);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (payload.usage) {
          usage = usageFrom(payload) ?? usage;
          sawUsage = true;
        }
      });
      const toolCalls = toolBuffer.list();
      return {
        text,
        usage: sawUsage ? usage : null,
        stopReason: finishReason === 'tool_calls' || toolCalls.length > 0 ? 'tool_use' : 'stop',
        toolCalls,
      };
    },
    180_000,
    options.signal,
  );
}

export async function listOpenAiModels(
  provider: AiProvider,
  apiKey: string | null,
): Promise<string[]> {
  return withTimeout(async (signal) => {
    const url = joinUrl(provider.baseUrl, provider.modelsPath || '/models');
    const response = await fetch(url, {
      method: 'GET',
      headers: providerHeaders(provider, apiKey),
      signal,
    });
    if (!response.ok)
      await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));
    const data = await readBoundedJson<{
      data?: { id?: string }[];
      models?: { id?: string; name?: string }[];
    }>(response);
    const models = [
      ...(data.data ?? []).map((item) => item.id ?? ''),
      ...(data.models ?? []).map((item) => item.id ?? item.name ?? ''),
    ].filter(Boolean);
    return Array.from(new Set(models)).slice(0, 500);
  }, 30_000);
}
