import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runAgentTurn: vi.fn(),
  buildWorkspaceTools: vi.fn(),
}));

vi.mock('../server/store/providers', () => ({
  resolveProvider: vi.fn().mockResolvedValue({
    stored: { id: 'p1' },
    public: {
      id: 'p1',
      name: 'Mock',
      type: 'openai',
      model: 'mock-1',
      temperature: 0.3,
      maxTokens: 1024,
      streaming: true,
      isDefault: true,
    },
    apiKey: 'key',
  }),
  listProviders: vi.fn().mockResolvedValue([]),
}));
vi.mock('../server/db/manager', () => ({ getCachedServerInfo: vi.fn().mockReturnValue(null) }));
vi.mock('../server/db/introspection', () => ({
  getSchemaSnapshot: vi.fn().mockResolvedValue({ database: 'shop', tables: [], fetchedAt: '' }),
}));
vi.mock('../server/db/scope', () => ({
  assertDatabaseAllowed: vi.fn(),
  getDatabaseScope: vi
    .fn()
    .mockResolvedValue({ mode: 'all', allowed: new Set(), serverWideInsights: true }),
}));
vi.mock('../server/store/practice', () => ({
  getPracticeSet: vi.fn().mockImplementation(async (id: string) =>
    id === 'set1'
      ? {
          id: 'set1',
          profileId: 'p1',
          database: 'shop',
          questions: [
            {
              id: 'q1',
              title: 'Top orders',
              type: 'write-query',
              difficulty: 'easy',
              topics: [],
              scenario: 'Find the top orders.',
              hints: [],
              schemaTables: ['orders'],
              brokenSql: null,
              referenceSql: 'SELECT secret FROM answers',
            },
          ],
        }
      : null,
  ),
}));
vi.mock('../server/ai/index', () => ({
  listModels: vi.fn(),
  testProvider: vi.fn(),
  complete: vi.fn(),
  stream: vi.fn(),
}));
vi.mock('../server/ai/agent', () => ({ runAgentTurn: h.runAgentTurn }));
vi.mock('../server/ai/agent-tools', () => ({
  buildWorkspaceTools: h.buildWorkspaceTools,
  // The coach toolset is exercised in agent-tools.test.ts; here both modes
  // use the same scripted toolset.
  buildCoachTools: h.buildWorkspaceTools,
  applyToolGovernance: (toolset: { definitions: unknown[]; handlers: Map<string, unknown> }) =>
    toolset,
  TOOL_RESULT_MAX_CHARS: 8_000,
}));

import { aiRouter } from '../server/routes/ai';
import type { PublicUser } from '../shared/types';

const user: PublicUser = {
  id: 'u1',
  username: 'tester',
  displayName: 'Tester',
  role: 'admin',
  assignments: [],
  createdAt: '2026-01-01T00:00:00Z',
  disabledAt: null,
};

function appWithUser(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: PublicUser }).user = user;
    next();
  });
  app.use('/api/ai', aiRouter);
  return app;
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

async function postAssist(server: Server): Promise<SseFrame[]> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/ai/assist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'workspace',
      providerId: 'p1',
      messages: [{ role: 'user', content: 'What tables exist?' }],
      context: { profileId: 'p1', database: 'shop', sql: 'SELECT 1' },
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      return { event, data: JSON.parse(dataLines.join('\n') || '{}') as Record<string, unknown> };
    });
}

describe('POST /api/ai/assist — agent path', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    vi.clearAllMocks();
  });

  it('streams thinking, tool_call and tool_result events and announces the toolkit', async () => {
    h.buildWorkspaceTools.mockReturnValue({
      definitions: [{ name: 'list_tables', description: 'd', parameters: { type: 'object' } }],
      handlers: new Map(),
    });
    h.runAgentTurn.mockImplementation(async (_input: unknown, emit: (e: unknown) => void) => {
      emit({ type: 'thinking', text: 'let me look' });
      emit({ type: 'tool_call', id: 'c1', name: 'list_tables', arguments: {} });
      emit({
        type: 'tool_result',
        id: 'c1',
        name: 'list_tables',
        ok: true,
        output: '{}',
        durationMs: 4,
      });
      emit({ type: 'delta', text: 'There are two tables.' });
      return {
        text: 'There are two tables.',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [{ id: 'c1', name: 'list_tables', arguments: {}, status: 'complete' }],
      };
    });

    server = appWithUser().listen(0);
    const frames = await postAssist(server);

    const meta = frames.find((frame) => frame.event === 'meta');
    expect(meta?.data).toMatchObject({ agent: true, tools: ['list_tables'], streaming: true });

    const events = frames.map((frame) => frame.event);
    expect(events).toContain('thinking');
    expect(events).toContain('tool_call');
    expect(events).toContain('tool_result');
    expect(events).toContain('delta');

    const toolCall = frames.find((frame) => frame.event === 'tool_call');
    expect(toolCall?.data).toEqual({ id: 'c1', name: 'list_tables', arguments: {} });
    const toolResult = frames.find((frame) => frame.event === 'tool_result');
    expect(toolResult?.data).toMatchObject({ id: 'c1', ok: true, durationMs: 4 });

    const result = frames.find((frame) => frame.event === 'result');
    expect(result?.data).toMatchObject({
      text: 'There are two tables.',
      usage: { totalTokens: 15 },
    });
    expect(frames[frames.length - 1].event).toBe('done');
  });

  it('screens the challenge coach: a leaking answer is replaced by the guard message', async () => {
    h.buildWorkspaceTools.mockReturnValue({
      definitions: [{ name: 'list_tables', description: 'd', parameters: { type: 'object' } }],
      handlers: new Map(),
    });
    h.runAgentTurn.mockImplementation(async (_input: unknown, emit: (e: unknown) => void) => {
      // The model streamed an answer that quotes the reference solution.
      emit({ type: 'delta', text: 'The answer is SELECT secret FROM answers' });
      return {
        text: 'The answer is SELECT secret FROM answers',
        usage: null,
        toolCalls: [],
      };
    });

    server = appWithUser().listen(0);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/assist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'challenge',
        providerId: 'p1',
        messages: [{ role: 'user', content: 'give me the answer' }],
        context: {
          profileId: 'p1',
          database: 'shop',
          question: { setId: 'set1', questionId: 'q1' },
        },
      }),
    });
    const text = await response.text();
    // The leaked answer never reaches the client; the guard replaces it.
    expect(text).not.toContain('SELECT secret');
    expect(text).toContain('stopped it');
    const result = text.split('\n\n').find((block) => block.startsWith('event: result'));
    expect(result).toContain('"guarded":"solution-detected"');
  });

  it('releases buffered deltas when the challenge coach answer is safe', async () => {
    h.buildWorkspaceTools.mockReturnValue({
      definitions: [{ name: 'list_tables', description: 'd', parameters: { type: 'object' } }],
      handlers: new Map(),
    });
    h.runAgentTurn.mockImplementation(async (_input: unknown, emit: (e: unknown) => void) => {
      emit({ type: 'tool_call', id: 'c1', name: 'list_tables', arguments: {} });
      emit({ type: 'delta', text: 'This challenge is about grouping.' });
      return { text: 'This challenge is about grouping.', usage: null, toolCalls: [] };
    });

    server = appWithUser().listen(0);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/assist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'challenge',
        providerId: 'p1',
        messages: [{ role: 'user', content: 'help me start' }],
        context: {
          profileId: 'p1',
          database: 'shop',
          question: { setId: 'set1', questionId: 'q1' },
        },
      }),
    });
    const text = await response.text();
    expect(text).toContain('This challenge is about grouping.');
    expect(text).toContain('event: tool_call');
    const result = text.split('\n\n').find((block) => block.startsWith('event: result'));
    expect(result).toContain('"guarded":null');
  });

  it('keeps the plain assistant path when the turn is not agent-eligible', async () => {
    // No tools: the workspace assistant runs without a database context.
    const { stream } = (await import('../server/ai/index')) as unknown as {
      stream: ReturnType<typeof vi.fn>;
    };
    stream.mockImplementationOnce(
      async (
        _provider: unknown,
        _key: unknown,
        _messages: unknown,
        handlers: { onDelta: (t: string) => void },
      ) => {
        handlers.onDelta('Plain ');
        handlers.onDelta('answer.');
        return { text: 'Plain answer.', usage: null, stopReason: 'stop', toolCalls: [] };
      },
    );

    server = appWithUser().listen(0);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/assist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'workspace',
        providerId: 'p1',
        messages: [{ role: 'user', content: 'hi' }],
        context: {},
      }),
    });
    const text = await response.text();
    expect(text).toContain('event: delta');
    expect(text).toContain('Plain answer.');
    expect(text).not.toContain('event: tool_call');
    const meta = text.split('\n\n').find((block) => block.startsWith('event: meta'));
    expect(meta).toContain('"agent":false');
  });
});
