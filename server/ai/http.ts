import { AppError } from '../errors';

/**
 * One tool the model may call. `parameters` is the JSON Schema for the
 * arguments object; every provider wire format is projected from this shape.
 */
export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A tool call the model made, normalized across providers. `arguments` is the
 * JSON text of the arguments object — OpenAI streams it as a string, the other
 * providers as an object, so the string is the common denominator and the
 * agent loop parses it once.
 */
export interface ChatToolCallSpec {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Assistant-only: the tool calls this message issued. */
  toolCalls?: ChatToolCallSpec[];
  /** Assistant-only: opaque reasoning blocks preserved verbatim (Anthropic). */
  thinkingBlocks?: unknown[];
  /** Tool-role-only: the id of the call this message answers. */
  toolCallId?: string;
  /** Tool-role-only: the tool name, some providers echo it back. */
  name?: string;
}

export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface CompleteResult {
  text: string;
  usage: ChatUsage | null;
  /** `'tool_use'` when the model stopped to ask for tool results. */
  stopReason?: 'stop' | 'tool_use';
  /** The calls the model issued, when `stopReason` is `'tool_use'`. */
  toolCalls?: ChatToolCallSpec[];
  /** Raw reasoning blocks to preserve across an Anthropic tool loop. */
  thinkingBlocks?: unknown[];
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: ChatToolDefinition[];
  /** Anthropic extended thinking budget; requires temperature 1/unset. */
  thinking?: { budgetTokens: number };
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  /** Native reasoning deltas (Anthropic thinking), separate from text. */
  onThinkingDelta?: (text: string) => void;
}

/** A `CompleteResult` with the tool fields defaulted, for provider modules. */
export function plainResult(text: string, usage: ChatUsage | null): CompleteResult {
  return { text, usage, stopReason: 'stop', toolCalls: [] };
}

/**
 * Hard ceiling on a provider response body. A hostile or broken provider must
 * not be able to exhaust the server's memory.
 */
export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Provider error bodies are only logged, so they get a much smaller cap. */
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;

/** Every secret that may appear in a provider error body. */
export function providerSecrets(
  provider: { headers?: Record<string, string> },
  apiKey: string | null,
): string[] {
  const values = [apiKey, ...Object.values(provider.headers ?? {})];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Replaces every known secret in a provider-controlled string. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join('***REDACTED***');
  }
  return out;
}

function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '0.0.0.0' || host === '::') return true;
  if (host === 'metadata' || host === 'metadata.google.internal') return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^fe80:/.test(host)) return true;
  return false;
}

/**
 * A provider base URL is fetched with the decrypted API key attached, so a
 * careless or hostile URL is a credential-exfiltration and SSRF vector. Only
 * absolute http(s) URLs without embedded credentials, query strings, or
 * link-local metadata addresses are accepted.
 */
export function assertProviderUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError('VALIDATION', 'The provider URL is not a valid absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('VALIDATION', 'The provider URL must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new AppError('VALIDATION', 'The provider URL must not embed credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new AppError(
      'VALIDATION',
      'The provider URL must not contain a query string or a fragment.',
    );
  }
  if (isMetadataHost(parsed.hostname)) {
    throw new AppError(
      'VALIDATION',
      'The provider URL must not point at a link-local metadata address.',
    );
  }
  return parsed;
}

export function joinUrl(baseUrl: string, path: string): string {
  assertProviderUrl(baseUrl);
  const base = baseUrl.replace(/\/+$/, '');
  if (!path) return base;
  if (path.split('/').some((segment) => segment === '..')) {
    throw new AppError('VALIDATION', 'The provider path must not contain ".." segments.');
  }
  return `${base}/${path.replace(/^\/+/, '')}`;
}

/**
 * Providers often wrap their JSON answer in a markdown fence, a short
 * preamble, or a short remark after the object. Recovering the JSON object
 * locally avoids a second billable "repair" round trip to the provider.
 *
 * A prose answer is returned untouched: the object is only taken when it is
 * surrounded by little more than a sentence.
 */
export function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (trimmed.startsWith('{')) {
    const slice = balancedObject(trimmed, 0);
    if (slice) return slice;
  }
  if (trimmed.startsWith('```')) {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const inner = (fenced ? fenced[1] : '').trim();
    if (inner.startsWith('{')) {
      const slice = balancedObject(inner, 0);
      if (slice) return slice;
    }
  }
  const start = trimmed.indexOf('{');
  if (start > 0 && start <= 200) {
    const slice = balancedObject(trimmed, start);
    if (slice && trimmed.length - slice.length - start <= 200) return slice;
  }
  return text;
}

/** The balanced JSON object that starts at `from`, or null. */
function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(from, index + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Reads a provider body with a hard size ceiling. */
export async function readBoundedText(
  response: Response,
  limit: number = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    throw new AppError('AI_RESPONSE_TOO_LARGE', 'The AI provider response was too large.', 502);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        throw new AppError('AI_RESPONSE_TOO_LARGE', 'The AI provider response was too large.', 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text;
}

/** Reads a provider JSON body with a hard size ceiling. */
export async function readBoundedJson<T>(response: Response, limit?: number): Promise<T> {
  const text = await readBoundedText(response, limit);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError('AI_BAD_RESPONSE', 'The AI provider returned a malformed response.', 502);
  }
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

export async function errorFromResponse(
  response: Response,
  providerName: string,
  secrets: string[] = [],
): Promise<never> {
  // Provider error bodies routinely echo the API key back to us. The body is
  // logged server-side with every secret redacted; the client only receives
  // the status and a stable error code.
  let detail = '';
  try {
    detail = redactSecrets(
      (await readBoundedText(response, MAX_PROVIDER_ERROR_BYTES)).trim(),
      secrets,
    );
  } catch {
    // A body that cannot be read is not worth reporting.
  }
  if (detail) {
    console.error(
      `[mylens] ${providerName} returned HTTP ${response.status}: ${detail.slice(0, 600)}`,
    );
  }

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
  throw new AppError(
    code,
    `${providerName} returned HTTP ${status}.`,
    status === 401 || status === 403 ? 401 : status === 429 ? 429 : 502,
  );
}

export async function readSse(
  response: Response,
  onEvent: (event: string, data: string) => void,
  options: { maxBytes?: number } = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_PROVIDER_RESPONSE_BYTES;
  if (!response.body) {
    throw new AppError('AI_STREAM_ERROR', 'The provider returned an empty stream.', 502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;

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
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError('AI_RESPONSE_TOO_LARGE', 'The AI provider stream was too large.', 502);
      }
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
