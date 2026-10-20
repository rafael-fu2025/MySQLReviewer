import { getApiToken, parseApiError } from './api';

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseHandlers {
  onEvent: (event: SseEvent) => void;
  onError?: (error: unknown) => void;
}

/**
 * POST-based SSE. EventSource cannot send headers or request bodies, so we
 * parse the stream ourselves with fetch.
 */
export async function postSse(
  path: string,
  body: unknown,
  handlers: SseHandlers,
  signal?: AbortSignal,
): Promise<void> {
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
    if ((error as Error).name === 'AbortError') return;
    const wrapped = error instanceof Error ? error : new Error(String(error));
    handlers.onError?.(wrapped);
    throw wrapped;
  }

  if (!response.ok) {
    const apiError = await parseApiError(response);
    handlers.onError?.(apiError);
    throw apiError;
  }
  if (!response.body) {
    const error = new Error('The server returned an empty event stream.');
    handlers.onError?.(error);
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
    handlers.onEvent({ event, data });
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
    if (buffer.trim()) dispatch(buffer);
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    handlers.onError?.(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
