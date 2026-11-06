import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  streamWithTools: vi.fn(),
  completeWithTools: vi.fn(),
}));

vi.mock('../server/ai/index', () => ({
  streamWithTools: h.streamWithTools,
  completeWithTools: h.completeWithTools,
}));

import { runAgentTurn, type AgentEvent } from '../server/ai/agent';
import type { AgentToolSet } from '../server/ai/agent-tools';
import type { ChatToolDefinition } from '../server/ai/http';
import type { AiProvider } from '../shared/types';

const provider = {
  id: 'p1',
  name: 'Test',
  type: 'openai' as const,
  streaming: true,
  temperature: 0.3,
  maxTokens: 1024,
} as AiProvider;

function toolSet(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<string>>,
): AgentToolSet {
  const definitions: ChatToolDefinition[] = Object.keys(handlers).map((name) => ({
    name,
    description: name,
    parameters: { type: 'object' },
  }));
  return { definitions, handlers: new Map(Object.entries(handlers)) };
}

/** The provider answer one scripted streamWithTools call returns. */
function answer(text: string) {
  return {
    text,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: 'stop' as const,
    toolCalls: [],
  };
}

function toolUse(calls: { id: string; name: string; arguments: string }[], text = '') {
  return {
    text,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: 'tool_use' as const,
    toolCalls: calls,
  };
}

function collect(): AgentEvent[] {
  const events: AgentEvent[] = [];
  return events;
}

async function run(handlers: Record<string, (args: Record<string, unknown>) => Promise<string>>) {
  const events = collect();
  const result = await runAgentTurn(
    {
      provider,
      apiKey: null,
      promptMessages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
      ],
      tools: toolSet(handlers),
    },
    (event) => events.push(event),
  );
  return { events, result };
}

beforeEach(() => {
  h.streamWithTools.mockReset();
  h.completeWithTools.mockReset();
});

describe('agent loop', () => {
  it('streams a straight answer with no tool round', async () => {
    h.streamWithTools.mockImplementationOnce(
      async (
        _provider: unknown,
        _key: unknown,
        _messages: unknown,
        handlers: { onDelta: (t: string) => void },
      ) => {
        handlers.onDelta('Hel');
        handlers.onDelta('lo.');
        return answer('Hello.');
      },
    );
    const { events, result } = await run({});

    expect(result.text).toBe('Hello.');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(events.some((event) => event.type === 'delta')).toBe(true);
  });

  it('runs a tool round and consolidates the assistant message before its results', async () => {
    h.streamWithTools
      .mockResolvedValueOnce(
        toolUse([{ id: 'c1', name: 'list_tables', arguments: '{"database":"shop"}' }]),
      )
      .mockResolvedValueOnce(answer('Two tables.'));
    const listTables = vi.fn().mockResolvedValue('{"tables":["a","b"]}');

    const { events, result } = await run({ list_tables: listTables });

    expect(result.text).toBe('Two tables.');
    expect(listTables).toHaveBeenCalledWith({ database: 'shop' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'list_tables', status: 'complete' });

    // The second provider call must carry the consolidated assistant message
    // (with its tool calls) followed by the tool result message — the order
    // OpenAI-compatible endpoints require.
    const secondCallMessages = h.streamWithTools.mock.calls[1][2];
    expect(secondCallMessages[2]).toMatchObject({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'c1', name: 'list_tables' }],
    });
    expect(secondCallMessages[3]).toMatchObject({
      role: 'tool',
      toolCallId: 'c1',
      content: '{"tables":["a","b"]}',
    });

    const toolEvents = events.filter(
      (event) => event.type === 'tool_call' || event.type === 'tool_result',
    );
    expect(toolEvents[0]).toMatchObject({ type: 'tool_call', id: 'c1', name: 'list_tables' });
    expect(toolEvents[1]).toMatchObject({ type: 'tool_result', id: 'c1', ok: true });
    expect(
      toolEvents[1].type === 'tool_result' ? toolEvents[1].durationMs : -1,
    ).toBeGreaterThanOrEqual(0);
  });

  it('keeps the turn alive when a tool fails and reports the error', async () => {
    h.streamWithTools
      .mockResolvedValueOnce(toolUse([{ id: 'c1', name: 'boom', arguments: '{}' }]))
      .mockResolvedValueOnce(answer('Recovered.'));
    const { result } = await run({
      boom: async () => {
        throw new Error('connection lost');
      },
    });

    expect(result.text).toBe('Recovered.');
    expect(result.toolCalls[0]).toMatchObject({
      status: 'error',
      error: 'connection lost',
    });
  });

  it('rejects invalid tool-call JSON instead of executing the tool', async () => {
    h.streamWithTools
      .mockResolvedValueOnce(toolUse([{ id: 'c1', name: 'f', arguments: 'not json' }]))
      .mockResolvedValueOnce(answer('ok'));
    const handler = vi.fn();
    const { result } = await run({ f: handler });

    expect(handler).not.toHaveBeenCalled();
    expect(result.toolCalls[0]).toMatchObject({ status: 'error' });
    expect(result.toolCalls[0].error).toContain('JSON');
  });

  it('reports an unknown tool and tells the model what is available', async () => {
    h.streamWithTools
      .mockResolvedValueOnce(toolUse([{ id: 'c1', name: 'nope', arguments: '{}' }]))
      .mockResolvedValueOnce(answer('ok'));
    const { result } = await run({ real: async () => '{}' });

    expect(result.toolCalls[0]).toMatchObject({ status: 'error' });
    expect(result.toolCalls[0].output).toContain('availableTools');
  });

  it('wraps up without tools once the round budget is spent', async () => {
    h.streamWithTools.mockResolvedValue(toolUse([{ id: `c`, name: 'loop', arguments: '{}' }]));
    h.completeWithTools.mockResolvedValueOnce(answer('Final answer from what I have.'));
    const { result } = await run({ loop: async () => '{}' });

    expect(h.streamWithTools).toHaveBeenCalledTimes(5);
    expect(h.completeWithTools).toHaveBeenCalledTimes(1);
    const wrapUpMessages = h.completeWithTools.mock.calls[0][2];
    expect(wrapUpMessages[wrapUpMessages.length - 1]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('tool budget'),
    });
    expect(result.text).toBe('Final answer from what I have.');
  });

  it('splits inline reasoning into thinking events and strips it from the answer', async () => {
    h.streamWithTools.mockImplementationOnce(
      async (
        _provider: unknown,
        _key: unknown,
        _messages: unknown,
        handlers: { onDelta: (t: string) => void },
      ) => {
        handlers.onDelta('<think>reasoning</think>Visible answer.');
        return answer('<think>reasoning</think>Visible answer.');
      },
    );
    const { events, result } = await run({});

    const thinking = events
      .filter((event) => event.type === 'thinking')
      .map((event) => (event as { text: string }).text)
      .join('');
    expect(thinking).toBe('reasoning');
    expect(result.text).toBe('Visible answer.');
  });
});
