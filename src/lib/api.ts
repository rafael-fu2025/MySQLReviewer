let apiToken = '';
let unauthorizedHandler: (() => void) | null = null;

export function setApiToken(token: string): void {
  apiToken = token;
}

export function getApiToken(): string {
  return apiToken;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export async function parseApiError(response: Response): Promise<ApiError> {
  let payload: ApiErrorBody | null;
  try {
    payload = (await response.json()) as ApiErrorBody;
  } catch {
    try {
      const text = await response.text();
      return new ApiError(
        `HTTP_${response.status}`,
        text.slice(0, 400) || `Request failed with HTTP ${response.status}.`,
        response.status,
      );
    } catch {
      return new ApiError(
        `HTTP_${response.status}`,
        `Request failed with HTTP ${response.status}.`,
        response.status,
      );
    }
  }
  return new ApiError(
    payload?.error?.code ?? `HTTP_${response.status}`,
    payload?.error?.message ?? `Request failed with HTTP ${response.status}.`,
    response.status,
    payload?.error?.details,
  );
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiToken) headers['x-mylens-token'] = apiToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  // The server enforces its own 300s ceiling per statement, so the client must
  // wait longer than that or it would abort valid slow queries first.
  const timeoutMs = options.timeoutMs ?? 360_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (options.signal?.aborted) {
      throw new ApiError('CANCELLED', 'The request was cancelled.', 499);
    }
    if (timedOut) {
      throw new ApiError(
        'TIMEOUT',
        `The request timed out after ${Math.round(timeoutMs / 1000)}s.`,
        504,
      );
    }
    throw new ApiError(
      'NETWORK_ERROR',
      `Could not reach the local MyLens server: ${(error as Error).message}`,
      0,
    );
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const apiError = await parseApiError(response);
    if (response.status === 401 && apiError.code === 'INVALID_TOKEN') {
      unauthorizedHandler?.();
    }
    throw apiError;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const payload = (await response.json()) as { data?: T };
    return payload.data as T;
  }
  return (await response.text()) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body ?? {}, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body ?? {}, options),
  del: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function downloadText(
  filename: string,
  content: string,
  mime = 'text/plain;charset=utf-8',
): void {
  downloadBlob(filename, new Blob([content], { type: mime }));
}

export async function downloadReport(id: string, format: 'md' | 'html' | 'json'): Promise<void> {
  const response = await fetch(`/api/reports/${encodeURIComponent(id)}/export?format=${format}`, {
    headers: apiToken ? { 'x-mylens-token': apiToken } : {},
  });
  if (!response.ok) throw await parseApiError(response);
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/i);
  const filename = match?.[1] ?? `mylens-report-${id}.${format}`;
  downloadBlob(filename, await response.blob());
}
