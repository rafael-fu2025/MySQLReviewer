import { AppError } from '../errors';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface CompleteResult {
  text: string;
  usage: ChatUsage | null;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (!path) return base;
  return `${base}/${path.replace(/^\/+/, '')}`;
}

export function emptyUsage(): ChatUsage {
  return { inputTokens: null, outputTokens: null, totalTokens: null };
}

export function providerHeaders(
  provider: {
    headers: Record<string, string>;
    authHeader: string;
    authPrefix: string;
  },
  apiKey: string | null,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...provider.headers,
    ...extra,
  };
  if (apiKey && provider.authHeader) {
    headers[provider.authHeader] = `${provider.authPrefix ?? ''}${apiKey}`;
  }
  return headers;
}

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AI request timed out.')), timeoutMs);
  const onAbort = (): void => controller.abort(new Error('AI request cancelled.'));
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const err = error as Error;
    if (err.name === 'AbortError' || controller.signal.aborted) {
      if (external?.aborted) {
        throw new AppError('AI_CANCELLED', 'The AI request was cancelled.', 499);
      }
      throw new AppError('AI_TIMEOUT', 'The AI provider did not respond in time.', 504);
    }
    throw new AppError('AI_NETWORK', `Could not reach the AI provider: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

export async function errorFromResponse(response: Response, providerName: string): Promise<never> {
  let detail = '';
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed) as {
          error?: { message?: string } | string;
          message?: string;
        };
        if (typeof parsed.error === 'string') detail = parsed.error;
        else if (parsed.error?.message) detail = parsed.error.message;
        else if (parsed.message) detail = parsed.message;
        else detail = trimmed;
      } catch {
        detail = trimmed;
      }
    }
  } catch {
    // Ignore body read errors.
  }
  detail = detail.slice(0, 600);

  const status = response.status;
  const code =
    status === 401 || status === 403
      ? 'AI_AUTH'
      : status === 404
        ? 'AI_NOT_FOUND'
        : status === 429
          ? 'AI_RATE_LIMIT'
          : status >= 500
            ? 'AI_UPSTREAM'
            : 'AI_BAD_REQUEST';
  const suffix = detail ? ` ${detail}` : '';
  throw new AppError(
    code,
    `${providerName} returned HTTP ${status}.${suffix}`,
    status === 401 || status === 403 ? 401 : status === 429 ? 429 : 502,
  );
}

export async function readSse(
  response: Response,
  onEvent: (event: string, data: string) => void,
): Promise<void> {
  if (!response.body) {
    throw new AppError('AI_STREAM_ERROR', 'The provider returned an empty stream.', 502);
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
    if (dataLines.length > 0) onEvent(event, dataLines.join('\n'));
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
  } finally {
    reader.releaseLock();
  }
}

export function normalizeOpenAiContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}
