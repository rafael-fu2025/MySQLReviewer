import type { AiProvider } from '../../shared/types';
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

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** `redacted_thinking` payload, preserved verbatim. */
  data?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function messagesUrl(provider: AiProvider): string {
  return joinUrl(provider.baseUrl, provider.chatPath || '/v1/messages');
}

/**
 * Projects the normalized message list onto the Anthropic wire shape.
 *
 * Anthropic has no `tool` role: a tool result travels as a user message whose
 * content holds `tool_result` blocks, and an assistant tool call is a
 * `tool_use` content block. Consecutive same-role messages are merged because
 * the API requires strict role alternation — the assistant context block and
 * the first user turn would otherwise arrive as two user messages.
 */
function toWireMessages(
  messages: ChatMessage[],
): { role: 'user' | 'assistant'; content: unknown }[] {
  const wire: { role: 'user' | 'assistant'; content: unknown }[] = [];
  const push = (role: 'user' | 'assistant', content: unknown): void => {
    const last = wire[wire.length - 1];
    if (last && last.role === role && !Array.isArray(last.content) && !Array.isArray(content)) {
      last.content = `${String(last.content ?? '')}\n\n${String(content ?? '')}`;
      return;
    }
    wire.push({ role, content });
  };

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      // Consecutive tool results fold into one user message.
      const last = wire[wire.length - 1];
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content ?? '',
      };
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as Record<string, unknown>[]).push(block);
      } else {
        wire.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (
      message.role === 'assistant' &&
      (message.toolCalls?.length || message.thinkingBlocks?.length)
    ) {
      const content: Record<string, unknown>[] = [];
      // Thinking blocks must be preserved complete and unmodified, at the
      // start of the assistant turn — the API validates their signature.
      for (const block of message.thinkingBlocks ?? []) {
        content.push(block as Record<string, unknown>);
      }
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        let input: unknown;
        try {
          input = JSON.parse(call.arguments || '{}') as unknown;
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      wire.push({ role: 'assistant', content });
      continue;
    }
    push(message.role === 'assistant' ? 'assistant' : 'user', message.content ?? '');
  }
  return wire;
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
  const conversation = toWireMessages(messages);
  // Extended thinking requires temperature to be unset and max_tokens above
  // the thinking budget.
  const budget = options.thinking?.budgetTokens ?? null;
  const maxTokens =
    budget != null
      ? Math.max(options.maxTokens ?? provider.maxTokens, budget + 4_096)
      : (options.maxTokens ?? provider.maxTokens);
  return {
    model: provider.model,
    max_tokens: maxTokens,
    ...(budget != null
      ? { thinking: { type: 'enabled', budget_tokens: budget } }
      : { temperature: options.temperature ?? provider.temperature }),
    ...(system ? { system } : {}),
    messages: conversation.length ? conversation : [{ role: 'user', content: 'Continue.' }],
    ...(options.tools?.length
      ? {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
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

/** Collects the `tool_use` blocks of a finished (non-streamed) response. */
function toolCallsFromContent(content: AnthropicContentBlock[] | undefined): ChatToolCallSpec[] {
  return (content ?? [])
    .filter((block) => block.type === 'tool_use' && block.name)
    .map((block, index) => ({
      id: block.id ?? `toolu_${index}`,
      name: block.name ?? '',
      arguments: JSON.stringify(block.input ?? {}),
    }));
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
      if (!response.ok)
        await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));
      const data = await readBoundedJson<AnthropicResponse>(response);
      const text = (data.content ?? [])
        .filter((block) => block.type === 'text' || !block.type)
        .map((block) => block.text ?? '')
        .join('');
      const toolCalls = toolCallsFromContent(data.content);
      return {
        text,
        usage: usageFrom(data),
        stopReason: data.stop_reason === 'tool_use' || toolCalls.length > 0 ? 'tool_use' : 'stop',
        toolCalls,
      };
    },
    180_000,
    options.signal,
  );
}

/**
 * Tracks the `tool_use` blocks of a streamed response. Anthropic opens each
 * block with `content_block_start`, streams its arguments as
 * `input_json_delta` fragments, and closes it with `content_block_stop`.
 */
class AnthropicToolBuffer {
  private readonly open = new Map<number, { id: string; name: string; json: string }>();

  start(index: number, block: AnthropicContentBlock): void {
    if (block.type === 'tool_use') {
      this.open.set(index, { id: block.id ?? '', name: block.name ?? '', json: '' });
    }
  }

  append(index: number, partial: string | undefined): void {
    const current = this.open.get(index);
    if (current && partial) current.json += partial;
  }

  list(): ChatToolCallSpec[] {
    return [...this.open.entries()]
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({
        id: call.id || `toolu_${index}`,
        name: call.name,
        arguments: call.json || '{}',
      }));
  }
}

/**
 * Tracks the `thinking` / `redacted_thinking` blocks of a streamed response.
 * The raw block objects are kept so they can be passed back unmodified on the
 * next request of a tool loop — the API validates their signature.
 */
class AnthropicThinkingBuffer {
  private readonly blocks = new Map<number, Record<string, unknown>>();

  start(index: number, block: AnthropicContentBlock): void {
    if (block.type === 'thinking') {
      this.blocks.set(index, { type: 'thinking', thinking: '' });
    } else if (block.type === 'redacted_thinking') {
      this.blocks.set(index, { type: 'redacted_thinking', data: block.data });
    }
  }

  appendDelta(index: number, delta: { thinking?: string; signature?: string }): void {
    const block = this.blocks.get(index);
    if (!block) return;
    if (typeof delta.thinking === 'string') {
      block.thinking = `${String(block.thinking ?? '')}${delta.thinking}`;
    }
    if (typeof delta.signature === 'string') {
      block.signature = delta.signature;
    }
  }

  list(): unknown[] {
    return [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  }
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
      if (!response.ok)
        await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));

      let text = '';
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let stopReason: string | null = null;
      const toolBuffer = new AnthropicToolBuffer();
      const thinkingBuffer = new AnthropicThinkingBuffer();
      await readSse(response, (_event, data) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(payload.type ?? '');
        if (type === 'content_block_start') {
          const index = Number(payload.index ?? 0);
          const block = payload.content_block as AnthropicContentBlock | undefined;
          if (block) {
            toolBuffer.start(index, block);
            thinkingBuffer.start(index, block);
          }
        } else if (type === 'content_block_delta') {
          const index = Number(payload.index ?? 0);
          const delta = payload.delta as
            | {
                type?: string;
                text?: string;
                partial_json?: string;
                thinking?: string;
                signature?: string;
              }
            | undefined;
          if (delta?.text) {
            text += delta.text;
            handlers.onDelta(delta.text);
          } else if (delta?.partial_json) {
            toolBuffer.append(index, delta.partial_json);
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            thinkingBuffer.appendDelta(index, { thinking: delta.thinking });
            handlers.onThinkingDelta?.(delta.thinking);
          } else if (delta?.type === 'signature_delta' && delta.signature) {
            thinkingBuffer.appendDelta(index, { signature: delta.signature });
          }
        } else if (type === 'message_start') {
          const message = payload.message as { usage?: { input_tokens?: number } } | undefined;
          inputTokens = message?.usage?.input_tokens ?? inputTokens;
        } else if (type === 'message_delta') {
          const delta = payload.delta as { stop_reason?: string } | undefined;
          stopReason = delta?.stop_reason ?? stopReason;
          const usage = payload.usage as { output_tokens?: number } | undefined;
          outputTokens = usage?.output_tokens ?? outputTokens;
        }
      });
      const toolCalls = toolBuffer.list();
      const thinkingBlocks = thinkingBuffer.list();
      const usage =
        inputTokens != null || outputTokens != null
          ? {
              inputTokens,
              outputTokens,
              totalTokens:
                inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
            }
          : null;
      return {
        text,
        usage,
        stopReason: stopReason === 'tool_use' || toolCalls.length > 0 ? 'tool_use' : 'stop',
        toolCalls,
        thinkingBlocks,
      };
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
    if (!response.ok)
      await errorFromResponse(response, provider.name, providerSecrets(provider, apiKey));
    const data = await readBoundedJson<{ data?: { id?: string }[] }>(response);
    return Array.from(
      new Set((data.data ?? []).map((item) => item.id ?? '').filter(Boolean)),
    ).slice(0, 500);
  }, 30_000);
}
