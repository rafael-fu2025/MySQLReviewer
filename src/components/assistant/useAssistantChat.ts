import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentToolCallView, AiAssistantMeta, AiChatMessage } from '@shared/types';
import { postSse } from '@/lib/sse';

/** One turn of the conversation. Same shape as the wire message. */
export type ChatTurn = AiChatMessage;

/**
 * The assistant turn that is still on its way, kept in one object so a single
 * rAF flush updates the whole draft.
 */
export interface AssistantDraft {
  content: string;
  thinking: string;
  toolCalls: AgentToolCallView[];
}

export const EMPTY_DRAFT: AssistantDraft = { content: '', thinking: '', toolCalls: [] };

export interface AssistantChatResult {
  text: string;
  /** Set by the server when the challenge guard replaced a leaking answer. */
  guarded?: string | null;
}

export interface UseAssistantChatOptions {
  /**
   * Builds the request body for one turn. It is called at send time, so it
   * always sees the current screen state (the editor text, the open
   * challenge) rather than the state of the render that started the chat.
   */
  buildRequest: (messages: ChatTurn[]) => Record<string, unknown>;
  /** Called once the server has confirmed the final answer. */
  onResult?: (result: AssistantChatResult) => void;
  /**
   * The transcript, when the host owns it.
   *
   * The host keeps one transcript per context (a query tab, a challenge), so
   * moving to another context and back does not throw the conversation away.
   */
  messages?: ChatTurn[];
  /** Called whenever the transcript changes. */
  onMessagesChange?: (turns: ChatTurn[]) => void;
}

export interface AssistantChat {
  messages: ChatTurn[];
  /** The answer that is still arriving: content, thinking and tool calls. */
  draft: AssistantDraft;
  streaming: boolean;
  error: string | null;
  /** The `meta` event of the most recent turn, when one arrived. */
  meta: AiAssistantMeta | null;
  send: (text: string) => void;
  stop: () => void;
  /** Throws the transcript away. */
  clear: () => void;
  /**
   * Drops an answer that is still on its way, but keeps the transcript.
   * Used when the context changes under an in-flight request.
   */
  abandon: () => void;
}

/**
 * The transport behind every assistant surface.
 *
 * Two details matter for a chat that streams:
 *
 * - The provider sends a delta per token. Writing each one into React state
 *   re-renders the whole transcript per token, so the deltas are buffered and
 *   flushed once per animation frame instead. Thinking text and tool-call
 *   events share the same flush, so the three lanes move together.
 * - The answer that already arrived must never be lost when the user stops
 *   the stream, so the buffers are flushed on the way out as well.
 */
export function useAssistantChat(options: UseAssistantChatOptions): AssistantChat {
  const [internal, setInternal] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState<AssistantDraft>(EMPTY_DRAFT);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<AiAssistantMeta | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const contentRef = useRef('');
  const thinkingRef = useRef('');
  const toolCallsRef = useRef<AgentToolCallView[]>([]);
  const frameRef = useRef<number | null>(null);
  // The busy flag lives in a ref as well, so two sends in the same tick
  // cannot both start a request against the same history.
  const streamingRef = useRef(false);

  const isControlled = options.messages !== undefined;
  const messages = isControlled ? (options.messages as ChatTurn[]) : internal;

  // The transcript a request is built from.
  const messagesRef = useRef<ChatTurn[]>(messages);
  // The array we last produced. The host may hand back a different array
  // with the same content; that is not a context switch.
  const producedRef = useRef<ChatTurn[] | null>(null);

  const buildRef = useRef(options.buildRequest);
  const onResultRef = useRef(options.onResult);
  const onMessagesRef = useRef(options.onMessagesChange);

  useEffect(() => {
    buildRef.current = options.buildRequest;
  }, [options.buildRequest]);

  useEffect(() => {
    onResultRef.current = options.onResult;
  }, [options.onResult]);

  useEffect(() => {
    onMessagesRef.current = options.onMessagesChange;
  }, [options.onMessagesChange]);

  // Adopt a transcript the host changed on its own — another query tab,
  // another challenge.
  useEffect(() => {
    if (messages === producedRef.current) return;
    messagesRef.current = messages;
    producedRef.current = messages;
  }, [messages]);

  const flush = useCallback((): void => {
    frameRef.current = null;
    setDraft({
      content: contentRef.current,
      thinking: thinkingRef.current,
      toolCalls: toolCallsRef.current,
    });
  }, []);

  const scheduleFlush = useCallback((): void => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(flush);
  }, [flush]);

  const cancelFrame = useCallback((): void => {
    if (frameRef.current === null) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  /** Publishes a new transcript to the host and to the local copy. */
  const publish = useCallback(
    (turns: ChatTurn[]): void => {
      messagesRef.current = turns;
      producedRef.current = turns;
      if (!isControlled) setInternal(turns);
      onMessagesRef.current?.(turns);
    },
    [isControlled],
  );

  /** Writes the in-flight draft into the transcript as a finished turn. */
  const publishDraft = useCallback((): void => {
    const content = contentRef.current.trim();
    const thinking = thinkingRef.current;
    const toolCalls = toolCallsRef.current;
    if (!content && !thinking && toolCalls.length === 0) return;
    publish([...messagesRef.current, { role: 'assistant', content, thinking, toolCalls }]);
  }, [publish]);

  const resetDraft = useCallback((): void => {
    contentRef.current = '';
    thinkingRef.current = '';
    toolCallsRef.current = [];
    cancelFrame();
    setDraft(EMPTY_DRAFT);
  }, [cancelFrame]);

  const stop = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    // Whatever arrived is still worth keeping, as a finished turn.
    publishDraft();
    resetDraft();
    setStreaming(false);
  }, [publishDraft, resetDraft]);

  const abandon = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    resetDraft();
    setStreaming(false);
  }, [resetDraft]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      cancelFrame();
    };
  }, [cancelFrame]);

  const send = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed || streamingRef.current) return;

      const next: ChatTurn[] = [...messagesRef.current, { role: 'user', content: trimmed }];
      publish(next);
      setError(null);
      resetDraft();
      streamingRef.current = true;
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      void postSse(
        '/api/ai/assist',
        buildRef.current(next),
        {
          onEvent: ({ event, data }) => {
            // A request that was stopped, or that belongs to a context the
            // user has left, must not write into the current transcript.
            if (abortRef.current !== controller) return;
            if (event === 'meta') {
              setMeta(data as AiAssistantMeta);
            } else if (event === 'delta') {
              const payload = data as { text?: string };
              if (!payload.text) return;
              contentRef.current += payload.text;
              scheduleFlush();
            } else if (event === 'thinking') {
              const payload = data as { text?: string };
              if (!payload.text) return;
              thinkingRef.current += payload.text;
              scheduleFlush();
            } else if (event === 'tool_call') {
              const payload = data as {
                id?: string;
                name?: string;
                arguments?: Record<string, unknown>;
              };
              if (!payload.id || !payload.name) return;
              toolCallsRef.current = [
                ...toolCallsRef.current,
                {
                  id: payload.id,
                  name: payload.name,
                  arguments: payload.arguments ?? {},
                  status: 'running',
                },
              ];
              scheduleFlush();
            } else if (event === 'tool_result') {
              const payload = data as {
                id?: string;
                ok?: boolean;
                output?: string;
                error?: string | null;
                durationMs?: number;
              };
              if (!payload.id) return;
              toolCallsRef.current = toolCallsRef.current.map((call) =>
                call.id === payload.id
                  ? {
                      ...call,
                      status: payload.ok === false ? ('error' as const) : ('complete' as const),
                      output: payload.output ?? call.output,
                      error: payload.error ?? undefined,
                      durationMs: payload.durationMs,
                    }
                  : call,
              );
              scheduleFlush();
            } else if (event === 'result') {
              const payload = data as {
                text?: string;
                guarded?: string | null;
                toolCalls?: AgentToolCallView[];
                usage?: AiChatMessage['usage'];
              };
              const answer = payload.text?.trim() || contentRef.current;
              const thinking = thinkingRef.current;
              const finalToolCalls =
                payload.toolCalls && payload.toolCalls.length > 0
                  ? payload.toolCalls
                  : toolCallsRef.current;
              cancelFrame();
              resetDraft();
              if (answer || thinking || finalToolCalls.length > 0) {
                publish([
                  ...messagesRef.current,
                  {
                    role: 'assistant',
                    content: answer,
                    thinking,
                    toolCalls: finalToolCalls,
                    usage: payload.usage ?? null,
                  },
                ]);
              }
              onResultRef.current?.({ text: answer, guarded: payload.guarded ?? null });
              streamingRef.current = false;
              setStreaming(false);
            } else if (event === 'error') {
              const payload = data as { message?: string };
              cancelFrame();
              resetDraft();
              setError(payload.message ?? 'The assistant request failed.');
              streamingRef.current = false;
              setStreaming(false);
              return;
            } else if (event === 'done') {
              streamingRef.current = false;
              setStreaming(false);
            }
          },
        },
        controller.signal,
      )
        .catch((cause: unknown) => {
          if ((cause as Error)?.name === 'AbortError') return;
          cancelFrame();
          resetDraft();
          setError(cause instanceof Error ? cause.message : String(cause));
          streamingRef.current = false;
          setStreaming(false);
        })
        .finally(() => {
          if (abortRef.current === controller) abortRef.current = null;
        });
    },
    [cancelFrame, publish, resetDraft, scheduleFlush],
  );

  const clear = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    resetDraft();
    publish([]);
    setError(null);
    setStreaming(false);
  }, [publish, resetDraft]);

  return { messages, draft, streaming, error, meta, send, stop, clear, abandon };
}
