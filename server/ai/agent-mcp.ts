import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerConfig } from '../../shared/types';
import { AppError } from '../errors';
import type { ChatToolDefinition } from './http';
import { TOOL_RESULT_MAX_CHARS } from './agent-tools';

/**
 * A minimal MCP client over stdio.
 *
 * The server is an admin-configured local command that speaks newline-framed
 * JSON-RPC 2.0: `initialize` → `notifications/initialized` → `tools/list`,
 * then one `tools/call` per use. The handshake and framing follow the same
 * pattern as the SeaSID reference bridge. Everything here degrades: a server
 * that fails to start is skipped for the turn, never fatal.
 */

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'mylens-agent', version: '1.1.0' };
const STARTUP_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_STDERR_LOG_CHARS = 2_000;

export interface McpToolListing {
  server: string;
  name: string;
  description?: string;
  schema: Record<string, unknown>;
}

export interface McpServerStatus {
  server: string;
  ok: boolean;
  error?: string;
  tools: McpToolListing[];
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class McpConnection {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderrLog = '';
  private killed = false;
  private failure: Error | null = null;
  private listings: McpToolListing[] = [];

  constructor(
    readonly config: McpServerConfig,
    private readonly onClosed: (connection: McpConnection) => void,
  ) {
    // A scrubbed environment: the child process must not inherit API keys or
    // session material, only what a local command needs to run.
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'TEMP', 'TMP', 'SYSTEMROOT', 'COMSPEC']) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    this.child = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      if (this.stderrLog.length < MAX_STDERR_LOG_CHARS) this.stderrLog += chunk;
    });
    this.child.on('error', (error: Error) => {
      this.failure = error;
      this.rejectAll();
      this.onClosed(this);
    });
    this.child.on('exit', () => {
      if (!this.failure) {
        this.failure = new Error(
          `MCP server "${config.name}" exited.${this.stderrLog ? ` stderr: ${this.stderrLog.slice(0, 300)}` : ''}`,
        );
      }
      this.rejectAll();
      this.onClosed(this);
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf('\n');
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (line) this.onFrame(line);
      boundary = this.buffer.indexOf('\n');
    }
  }

  private onFrame(line: string): void {
    let frame: { id?: number | string; result?: unknown; error?: { message?: string } };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return; // A notification or garbage frame: nothing pending cares.
    }
    if (frame.id == null) return;
    const pending = this.pending.get(Number(frame.id));
    if (!pending) return;
    this.pending.delete(Number(frame.id));
    clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(new Error(frame.error.message || 'The MCP server returned an error.'));
    } else {
      pending.resolve((frame.result ?? {}) as Record<string, unknown>);
    }
  }

  private rejectAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure ?? new Error('The MCP server closed.'));
    }
    this.pending.clear();
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.killed || this.failure) {
      return Promise.reject(this.failure ?? new Error('The MCP server is stopped.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError('AI_TIMEOUT', `The MCP server did not answer "${method}" in time.`, 504),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin?.write(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Handshake + tool discovery. Resolves once the tool list is known. */
  async start(): Promise<McpToolListing[]> {
    await this.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      STARTUP_TIMEOUT_MS,
    );
    // The notification has no id and expects no response.
    this.child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const listing = await this.request('tools/list', {}, STARTUP_TIMEOUT_MS);
    const tools = Array.isArray(listing.tools) ? (listing.tools as McpToolListing[]) : [];
    this.listings = tools
      .filter((tool) => typeof tool?.name === 'string' && tool.name)
      .map((tool) => ({
        server: this.config.name,
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        schema:
          tool.schema && typeof tool.schema === 'object'
            ? (tool.schema as Record<string, unknown>)
            : { type: 'object' },
      }));
    return this.listings;
  }

  /** The tool list from the handshake, cached. */
  get tools(): McpToolListing[] {
    return this.listings;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('\n');
    if (result.isError === true) {
      return JSON.stringify({
        error: text.slice(0, TOOL_RESULT_MAX_CHARS) || 'The MCP tool failed.',
      });
    }
    return text.slice(0, TOOL_RESULT_MAX_CHARS) || '(empty result)';
  }

  kill(): void {
    this.killed = true;
    this.rejectAll();
    try {
      this.child.kill();
    } catch {
      // Already gone.
    }
    this.onClosed(this);
  }
}

const sessions = new Map<string, McpConnection>();

async function getSession(config: McpServerConfig): Promise<McpConnection> {
  const existing = sessions.get(config.name);
  if (existing) return existing;
  const connection = new McpConnection(config, (dead) => {
    if (sessions.get(dead.config.name) === dead) sessions.delete(dead.config.name);
  });
  // Register before the handshake so a concurrent caller shares the session
  // instead of spawning a second child.
  sessions.set(config.name, connection);
  try {
    await connection.start();
  } catch (error) {
    connection.kill();
    throw error;
  }
  return connection;
}

/** Tool listings per configured server; a failed server degrades to an error entry. */
export async function listMcpTools(servers: McpServerConfig[]): Promise<McpServerStatus[]> {
  const statuses = await Promise.all(
    servers.map(async (config): Promise<McpServerStatus> => {
      try {
        const connection = await getSession(config);
        return { server: config.name, ok: true, tools: connection.tools };
      } catch (cause) {
        return {
          server: config.name,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
          tools: [],
        };
      }
    }),
  );
  return statuses;
}

/** Executes one MCP tool call through the cached session. */
export async function callMcpTool(
  server: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const connection = sessions.get(server);
  if (!connection) throw new Error(`The MCP server "${server}" is not connected.`);
  return connection.callTool(toolName, args);
}

/** Kills every MCP child process; called from the server shutdown path. */
export function shutdownMcp(): void {
  for (const connection of sessions.values()) connection.kill();
  sessions.clear();
}

function safeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'tool'
  );
}

/**
 * Builds the merged MCP toolset: one definition and handler per advertised
 * tool, named `mcp_<server>_<tool>`. The per-server allowlist wins first,
 * admin governance (`disabledAgentTools`) is applied afterwards by the route.
 */
export async function buildMcpTools(servers: McpServerConfig[]): Promise<{
  definitions: ChatToolDefinition[];
  handlers: Map<string, (args: Record<string, unknown>) => Promise<string>>;
}> {
  const definitions: ChatToolDefinition[] = [];
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  const statuses = await listMcpTools(servers);
  for (const status of statuses) {
    if (!status.ok) continue;
    const config = servers.find((entry) => entry.name === status.server);
    const allow = config?.allowedTools?.length ? new Set(config.allowedTools) : null;
    const slug = safeSlug(status.server);
    for (const tool of status.tools) {
      if (allow && !allow.has(tool.name)) continue;
      const mergedName = `mcp_${slug}_${safeSlug(tool.name)}`;
      if (handlers.has(mergedName)) continue;
      definitions.push({
        name: mergedName,
        description:
          tool.description?.slice(0, 500) ||
          `Tool ${tool.name} from the MCP server ${status.server}.`,
        parameters: tool.schema,
      });
      handlers.set(mergedName, async (args) => callMcpTool(status.server, tool.name, args));
    }
  }
  return { definitions, handlers };
}

/** Test hook: forgets every cached session. */
export function resetMcpSessions(): void {
  sessions.clear();
}
