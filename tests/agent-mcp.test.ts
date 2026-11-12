import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...(args as [])) };
});

import { buildMcpTools, listMcpTools, resetMcpSessions, shutdownMcp } from '../server/ai/agent-mcp';

interface FakeServerOptions {
  tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  callResults?: Record<string, string>;
  failToStart?: boolean;
}

/**
 * A fake stdio MCP server: answers the handshake and tools/list synchronously
 * whenever the client writes a request.
 */
function fakeMcpChild(options: FakeServerOptions = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (enc: string) => void };
    stderr: EventEmitter & { setEncoding: (enc: string) => void };
    stdin: { write: (chunk: string) => boolean };
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter() as never;
  child.stdout.setEncoding = () => child;
  child.stderr = new EventEmitter() as never;
  child.stderr.setEncoding = () => child;
  child.pid = 4242;
  child.kill = vi.fn();
  const stdinWrites: string[] = [];

  const emitResult = (id: number, result: unknown): void => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`));
  };

  child.stdin = {
    write: (chunk: string): boolean => {
      stdinWrites.push(chunk);
      const request = JSON.parse(chunk) as {
        id?: number;
        method?: string;
        params?: { name?: string };
      };
      if (request.id == null) return true; // a notification expects no reply
      if (request.method === 'initialize') {
        if (options.failToStart) {
          child.emit('error', new Error('spawn failed'));
        } else {
          emitResult(request.id, {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake' },
          });
        }
      } else if (request.method === 'tools/list') {
        emitResult(request.id, { tools: options.tools ?? [] });
      } else if (request.method === 'tools/call') {
        emitResult(request.id, {
          content: [
            { type: 'text', text: options.callResults?.[request.params?.name ?? ''] ?? 'ok' },
          ],
        });
      }
      return true;
    },
  };
  return { child, stdinWrites };
}

beforeEach(() => {
  spawnMock.mockReset();
  resetMcpSessions();
});

describe('agent MCP client', () => {
  it('handshakes, lists tools and calls one through the cached session', async () => {
    const fake = fakeMcpChild({
      tools: [{ name: 'fetch', description: 'Fetch a URL', inputSchema: { type: 'object' } }],
      callResults: { fetch: 'fetched page' },
    });
    spawnMock.mockReturnValue(fake.child);

    const { definitions, handlers } = await buildMcpTools([
      { name: 'docs', command: 'uvx', args: ['mcp-server-fetch'] },
    ]);

    // Handshake frames, in order.
    const methods = fake.stdinWrites.map(
      (chunk) => (JSON.parse(chunk) as { method?: string }).method,
    );
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      name: 'mcp_docs_fetch',
      description: 'Fetch a URL',
      parameters: { type: 'object' },
    });

    const handler = handlers.get('mcp_docs_fetch');
    expect(handler).toBeDefined();
    const output = await handler!({ url: 'https://example.com' });
    expect(output).toBe('fetched page');

    const callFrame = JSON.parse(fake.stdinWrites.at(-1)!);
    expect(callFrame.method).toBe('tools/call');
    expect(callFrame.params).toEqual({ name: 'fetch', arguments: { url: 'https://example.com' } });
  });

  it('respects the per-server tool allowlist', async () => {
    const fake = fakeMcpChild({
      tools: [{ name: 'fetch' }, { name: 'write_file' }],
    });
    spawnMock.mockReturnValue(fake.child);

    const { definitions } = await buildMcpTools([
      { name: 'srv', command: 'cmd', allowedTools: ['fetch'] },
    ]);
    expect(definitions.map((definition) => definition.name)).toEqual(['mcp_srv_fetch']);
  });

  it('skips a server that fails to start instead of failing the turn', async () => {
    const fake = fakeMcpChild({ failToStart: true });
    spawnMock.mockReturnValue(fake.child);

    const statuses = await listMcpTools([{ name: 'broken', command: 'nope' }]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ server: 'broken', ok: false });
    expect(statuses[0].error).toContain('spawn failed');

    const { definitions } = await buildMcpTools([{ name: 'broken', command: 'nope' }]);
    expect(definitions).toEqual([]);
  });

  it('spawns with a scrubbed environment and no shell', async () => {
    const fake = fakeMcpChild({ tools: [] });
    spawnMock.mockReturnValue(fake.child);
    await listMcpTools([{ name: 'srv', command: 'cmd', args: ['--x'] }]);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe('cmd');
    expect(args).toEqual(['--x']);
    expect(options.shell).toBeUndefined();
    // The child gets only the allowlisted keys that exist in this environment.
    // TEMP/TMP are Windows-only in practice, so assert the set membership
    // rather than a fixed list.
    const allowed = ['COMSPEC', 'HOME', 'LANG', 'PATH', 'SYSTEMROOT', 'TEMP', 'TMP'];
    expect(Object.keys(options.env).sort()).toEqual(
      allowed.filter((key) => Boolean(process.env[key])).sort(),
    );
    // Nothing outside the allowlist may leak in.
    for (const key of Object.keys(options.env)) {
      expect(allowed).toContain(key);
    }
  });

  it('isolates cached child processes by account and exact config', async () => {
    const first = fakeMcpChild({ tools: [{ name: 'fetch' }] });
    const second = fakeMcpChild({ tools: [{ name: 'fetch' }] });
    const changed = fakeMcpChild({ tools: [{ name: 'fetch' }] });
    spawnMock
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child)
      .mockReturnValueOnce(changed.child);

    const config = [{ name: 'docs', command: 'cmd', args: ['one'] }];
    await listMcpTools(config, { userId: 'u1' });
    await listMcpTools(config, { userId: 'u1' });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await listMcpTools(config, { userId: 'u2' });
    expect(spawnMock).toHaveBeenCalledTimes(2);

    await listMcpTools([{ ...config[0], args: ['two'] }], { userId: 'u1' });
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it('kills every child on shutdown', async () => {
    const fake = fakeMcpChild({ tools: [{ name: 'a' }] });
    spawnMock.mockReturnValue(fake.child);
    await listMcpTools([{ name: 'srv', command: 'cmd' }]);
    shutdownMcp();
    expect(fake.child.kill).toHaveBeenCalled();
  });
});
