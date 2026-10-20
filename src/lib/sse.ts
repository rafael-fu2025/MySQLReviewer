import { getApiToken, parseApiError } from './api';

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseHandlers {
  onEvent: (event: SseEvent) => void;
  /**
   * @deprecated Errors are always thrown by `postSse`; this handler is never
   * invoked. The property stays optional so existing call sites compile, but a
   * single error path keeps failures from being reported twice.
   */
  onError?: (error: unknown) => void;
}

export interface SseOptions {
  /** Abort when no bytes arrive for this long. Heartbeat comments count. */
  stallMs?: number;
  /** Hard cap for the whole stream, regardless of activity. */
  totalMs?: number;
  /** Event names that mark a complete stream. */
  terminalEvents?: string[];
}

const DEFAULT_STALL_MS = 60_000;
const DEFAULT_TOTAL_MS = 600_000;
const DEFAULT_TERMINAL_EVENTS = ['result', 'error', 'done'];

/** Thrown when the caller aborts. `name` stays 'AbortError' for existing checks. */
export class SseCancelledError extends Error {
  constructor(message = 'The stream was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Thrown when the stream goes quiet for too long or outlives the hard cap. */
export class SseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseTimeoutError';
  }
}

/** Thrown when the connection closes without a terminal event. */
export class SseIncompleteError extends Error {
  constructor(message = 'The stream ended unexpectedly before it reported a result.') {
    super(message);
    this.name = 'SseIncompleteError';
  }
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

/**
 * POST-based SSE. EventSource cannot send headers or request bodies, so we
 * parse the stream ourselves with fetch.
 *
 * Contract: resolves only when a terminal event (`result`/`error`/`done`) was
 * received. Every failure — network, HTTP, stall, cancellation, truncated
 * stream — is thrown, never reported through `handlers.onError`.
 */
export async function postSse(
  path: string,
  body: unknown,
  handlers: SseHandlers,
  signal?: AbortSignal,
  options: SseOptions = {},
): Promise<void> {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const totalMs = options.totalMs ?? DEFAULT_TOTAL_MS;
  const terminalEvents = options.terminalEvents ?? DEFAULT_TERMINAL_EVENTS;

  const token = getApiToken();
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { 'x-mylens-token': token } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbort(error) || signal?.aborted) throw new SseCancelledError();
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (!response.ok) throw await parseApiError(response);
  if (!response.body) throw new Error('The server returned an empty event stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminal = false;
  let stopReason: 'abort' | 'stall' | 'total' | null = null;

  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: 'abort' | 'stall' | 'total'): void => {
    if (stopReason) return;
    stopReason = reason;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
    // Cancelling resolves the pending read with `done`, which unwinds the loop.
    void reader.cancel().catch(() => undefined);
  };

  const resetStall = (): void => {
    if (stopReason) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stop('stall'), stallMs);
  };

  resetStall();
  const totalTimer = setTimeout(() => stop('total'), totalMs);
  const onAbort = (): void => stop('abort');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const dispatch = (block: string): void => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      data = raw;
    }
    if (terminalEvents.includes(event)) sawTerminal = true;
    handlers.onEvent({ event, data });
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStall();
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatch(block);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    // A stopped stream may end mid-event; only a clean end has a full block.
    if (!stopReason && buffer.trim()) dispatch(buffer);
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after cancellation.
    }
  }

  if (stopReason === 'abort') throw new SseCancelledError();
  if (stopReason === 'stall') {
    throw new SseTimeoutError(
      `The stream stalled for ${Math.round(stallMs / 1000)}s without any data.`,
    );
  }
  if (stopReason === 'total') {
    throw new SseTimeoutError(
      `The stream exceeded the ${Math.round(totalMs / 60_000)} minute limit.`,
    );
  }
  if (!sawTerminal) throw new SseIncompleteError();
}
