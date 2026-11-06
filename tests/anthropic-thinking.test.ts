import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  streamWithTools: vi.fn(),
  completeWithTools: vi.fn(),
}));

// The agent loop reaches the provider through ../server/ai/index; mock it so
// the loop can be driven without a network. The direct `streamAnthropic`
// tests below are unaffected by this mock.
vi.mock('../server/ai/index', () => ({
  streamWithTools: h.streamWithTools,
  completeWithTools: h.completeWithTools,
}));

import { streamAnthropic } from '../server/ai/anthropic';
import { runAgentTurn } from '../server/ai/agent';
import type { AiProvider } from '../shared/types';

const provider = {
  id: 'p1',
  name: 'Claude',
  type: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  chatPath: '/v1/messages',
  modelsPath: '/v1/models',
  model: 'claude-test',
  temperature: 0.3,
  maxTokens: 1024,
  streaming: true,
} as AiProvider;

/** A provider SSE response built from raw event strings. */
function sseResponse(events: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sse(payload: unknown): string {
  return `event: content\ndata: ${JSON.stringify(payload)}\n\n`;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  h.streamWithTools.mockReset();
  h.completeWithTools.mockReset();
});

describe('streamAnthropic — extended thinking', () => {
  it('sends the thinking budget, drops temperature, and raises max_tokens above it', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ type: 'message_stop' })]));
    await streamAnthropic(
      provider,
      'key',
      [{ role: 'user', content: 'q' }],
      { onDelta: () => {} },
      { temperature: 0.3, thinking: { budgetTokens: 2_000 } },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2_000 });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThanOrEqual(2_000 + 4_096);
  });

  it('keeps temperature when thinking is off', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([sse({ type: 'message_stop' })]));
    await streamAnthropic(provider, 'key', [{ role: 'user', content: 'q' }], { onDelta: () => {} });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.3);
  });

  it('streams thinking deltas and returns the raw blocks for preservation', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sse({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'step one ' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'step two' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-abc' },
        }),
        sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        sse({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Answer' },
        }),
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 5 },
        }),
      ]),
    );
    const thinking: string[] = [];
    const deltas: string[] = [];
    const result = await streamAnthropic(
      provider,
      'key',
      [{ role: 'user', content: 'q' }],
      {
        onDelta: (text) => deltas.push(text),
        onThinkingDelta: (text) => thinking.push(text),
      },
      { thinking: { budgetTokens: 2_000 } },
    );

    expect(thinking.join('')).toBe('step one step two');
    expect(deltas.join('')).toBe('Answer');
    expect(result.text).toBe('Answer');
    expect(result.stopReason).toBe('stop');
    expect(result.thinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'step one step two', signature: 'sig-abc' },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });
});

describe('agent loop with extended thinking', () => {
  it('preserves captured thinking blocks on the next assistant turn', async () => {
    const blocks = [{ type: 'thinking', thinking: 'reason', signature: 'sig-1' }];
    h.streamWithTools
      .mockResolvedValueOnce({
        text: '',
        usage: null,
        stopReason: 'tool_use',
        toolCalls: [{ id: 'toolu_1', name: 'f', arguments: '{}' }],
        thinkingBlocks: blocks,
      })
      .mockResolvedValueOnce({ text: 'done', usage: null, stopReason: 'stop', toolCalls: [] });

    const result = await runAgentTurn(
      {
        provider: { ...provider, thinkingEnabled: true },
        apiKey: 'key',
        promptMessages: [{ role: 'user', content: 'q' }],
        tools: { definitions: [], handlers: new Map([['f', async () => '{}']]) },
      },
      () => undefined,
    );
    expect(result.text).toBe('done');

    // The loop must request a thinking budget when the provider enables it,
    // and the second call must carry the preserved blocks unmodified.
    expect(h.streamWithTools.mock.calls[0][4]).toMatchObject({
      thinking: { budgetTokens: expect.any(Number) },
    });
    const secondCallMessages = h.streamWithTools.mock.calls[1][2];
    expect(secondCallMessages[1].thinkingBlocks).toEqual(blocks);
  });
});
