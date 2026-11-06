import type { AiProvider, AgentToolCallView } from '../../shared/types';
import { AppError } from '../errors';
import {
  completeWithTools,
  streamWithTools,
  type ChatMessage,
  type ChatToolCallSpec,
  type ChatUsage,
} from './index';
import { feedThinking, flushThinking, makeThinkSplitter, stripThinkBlocks } from './thinking';
import { truncateToolOutput, type AgentToolSet } from './agent-tools';

/**
 * The agent loop behind the workspace assistant.
 *
 * One turn is a bounded conversation with the provider: the model answers or
 * asks for a tool, the tool runs server-side behind the same guards as the
 * interactive UI, its result goes back as a `tool` message, and the loop
 * repeats — at most {@link MAX_TOOL_ROUNDS} times. Text deltas stream out as
 * they arrive, with inline `<think>` reasoning split onto its own lane.
 *
 * Two details come straight from the SeaSID reference implementation:
 *
 * - The assistant message that issued tool calls is appended **consolidated**
 *   before any tool result is appended. OpenAI-compatible endpoints reject
 *   the exchange with HTTP 400 otherwise.
 * - Tool failures are returned to the model as readable JSON errors instead
 *   of aborting the turn, so it can self-correct.
 */

/** Provider calls per turn that may end in tool calls. */
const MAX_TOOL_ROUNDS = 5;

/** Reasoning budget when the provider has extended thinking enabled. */
const ANTHROPIC_THINKING_BUDGET_TOKENS = 4_096;

/** Whole-turn wall clock, inside the client's 600s stream cap. */
const AGENT_TOTAL_BUDGET_MS = 270_000;

/** Per-tool execution cap; a slow query must not hold the stream hostage. */
const TOOL_TIMEOUT_MS = 30_000;

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      output: string;
      error?: string;
      durationMs: number;
    };

export type AgentEmit = (event: AgentEvent) => void;

export interface AgentRunInput {
  provider: AiProvider;
  apiKey: string | null;
  /** The prompt for this turn, already built (system, context, conversation). */
  promptMessages: ChatMessage[];
  tools: AgentToolSet;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  text: string;
  usage: ChatUsage | null;
  /** Every tool call of the turn, in order, with its outcome. */
  toolCalls: AgentToolCallView[];
}

function addUsage(into: ChatUsage | null, add: ChatUsage | null): ChatUsage | null {
  if (!add) return into;
  const base = into ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    inputTokens: (base.inputTokens ?? 0) + (add.inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (add.outputTokens ?? 0),
    totalTokens:
      base.inputTokens != null &&
      base.outputTokens != null &&
      add.inputTokens != null &&
      add.outputTokens != null
        ? (base.inputTokens ?? 0) +
          (add.inputTokens ?? 0) +
          (base.outputTokens ?? 0) +
          (add.outputTokens ?? 0)
        : (base.totalTokens ?? 0) + (add.totalTokens ?? 0),
  };
}

/** Parses model-provided arguments; invalid JSON becomes a tool failure. */
function parseToolArguments(call: ChatToolCallSpec): {
  args: Record<string, unknown>;
  parseError?: string;
} {
  try {
    const parsed = JSON.parse(call.arguments || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, parseError: 'The tool arguments were not a JSON object.' };
  } catch {
    return { args: {}, parseError: 'The tool arguments were not valid JSON.' };
  }
}

function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  done: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(new Error('AI request cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('The tool timed out.')), timeoutMs);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

const WRAP_UP_MESSAGE =
  'You have reached the tool budget for this turn. Answer the user now from what you already know; state plainly what you could not check.';

/**
 * Runs one agent turn and streams its progress through `emit`.
 *
 * The caller is the route: it maps `AgentEvent`s onto the SSE stream and
 * keeps the abort signal wired to the closed response.
 */
export async function runAgentTurn(input: AgentRunInput, emit: AgentEmit): Promise<AgentRunResult> {
  const { provider, apiKey, tools, signal } = input;
  const messages: ChatMessage[] = [...input.promptMessages];
  const splitter = makeThinkSplitter();
  const deadline = Date.now() + AGENT_TOTAL_BUDGET_MS;
  let usage: ChatUsage | null = null;
  const toolLog: AgentToolCallView[] = [];

  const onDelta = (text: string): void => {
    const split = feedThinking(splitter, text);
    if (split.thinking) emit({ type: 'thinking', text: split.thinking });
    if (split.visible) emit({ type: 'delta', text: split.visible });
  };

  // Anthropic extended thinking: reasoning arrives as native deltas and the
  // raw blocks must be preserved for the next round of the tool loop.
  const thinking = input.provider.thinkingEnabled
    ? { budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS }
    : undefined;

  const checkBudget = (): void => {
    if (signal?.aborted) {
      throw new AppError('AI_CANCELLED', 'The AI request was cancelled.', 499);
    }
    if (Date.now() > deadline) {
      throw new AppError('AI_TIMEOUT', 'The agent turn ran out of time.', 504);
    }
  };

  let finalText: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    checkBudget();
    const result = await streamWithTools(
      provider,
      apiKey,
      messages,
      { onDelta, onThinkingDelta: (text) => emit({ type: 'thinking', text }) },
      {
        temperature: provider.temperature,
        maxTokens: provider.maxTokens,
        signal,
        tools: tools.definitions,
        thinking,
      },
    );
    usage = addUsage(usage, result.usage);

    const flush = flushThinking(splitter);
    if (flush.thinking) emit({ type: 'thinking', text: flush.thinking });
    if (flush.visible) emit({ type: 'delta', text: flush.visible });

    if (result.stopReason === 'tool_use' && result.toolCalls?.length) {
      // The consolidated assistant message must precede its tool results, and
      // with extended thinking it must carry the reasoning blocks unmodified.
      messages.push({
        role: 'assistant',
        content: result.text || null,
        toolCalls: result.toolCalls,
        ...(result.thinkingBlocks?.length ? { thinkingBlocks: result.thinkingBlocks } : {}),
      });
      for (const call of result.toolCalls) {
        checkBudget();
        const { args, parseError } = parseToolArguments(call);
        emit({ type: 'tool_call', id: call.id, name: call.name, arguments: args });

        const started = Date.now();
        let ok = true;
        let error: string | undefined;
        let output: string;
        if (parseError) {
          ok = false;
          error = parseError;
          output = JSON.stringify({ error: parseError });
        } else {
          const handler = tools.handlers.get(call.name);
          if (!handler) {
            ok = false;
            error = `Unknown tool "${call.name}".`;
            output = JSON.stringify({ error, availableTools: [...tools.handlers.keys()] });
          } else {
            const guard = withTimeoutSignal(signal, TOOL_TIMEOUT_MS);
            try {
              output = truncateToolOutput(await handler(args));
            } catch (cause) {
              ok = false;
              error =
                cause instanceof AppError
                  ? cause.message
                  : cause instanceof Error
                    ? cause.message
                    : String(cause);
              output = JSON.stringify({ error });
            } finally {
              guard.done();
            }
          }
        }
        const durationMs = Date.now() - started;
        emit({ type: 'tool_result', id: call.id, name: call.name, ok, output, error, durationMs });
        toolLog.push({
          id: call.id,
          name: call.name,
          arguments: args,
          status: ok ? 'complete' : 'error',
          output,
          error,
          durationMs,
        });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output });
      }
      continue;
    }

    finalText = result.text;
    break;
  }

  if (finalText === null) {
    // Out of tool rounds while the model still wanted tools: one last call
    // without tools, told to answer from what it has.
    checkBudget();
    const last = await completeWithTools(
      provider,
      apiKey,
      [...messages, { role: 'user', content: WRAP_UP_MESSAGE }],
      {
        temperature: provider.temperature,
        maxTokens: provider.maxTokens,
        signal,
        thinking,
      },
    );
    usage = addUsage(usage, last.usage);
    finalText = last.text;
  }

  // The raw provider text still carries the inline reasoning; the client was
  // fed the split lanes, so the finished answer is stored clean.
  return { text: stripThinkBlocks(finalText ?? '').trim(), usage, toolCalls: toolLog };
}
