let apiToken = '';
let unauthorizedHandler: (() => void) | null = null;

/**
 * Every account-scoped request carries the user the caller believes owns the
 * browser session. The server must compare this header with its resolved
 * session user before doing any work (see the implementation note in the final
 * report). It closes the otherwise unavoidable cookie race during account
 * switches: an old request can never execute under the new cookie's account.
 */
export const EXPECTED_USER_HEADER = 'x-mylens-expected-user-id';

export interface ApiSessionSnapshot {
  readonly epoch: number;
  readonly userId: string | null;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Use a snapshot captured when delayed work was scheduled. */
  session?: ApiSessionSnapshot;
  /** Bootstrap/logout/workspace flushes are the only requests allowed while frozen. */
  allowDuringTransition?: boolean;
  /** Probe endpoints may intentionally discover the cookie user without asserting the current owner. */
  includeExpectedUser?: boolean;
  /** A bootstrap probe may run while the settled session remains usable. */
  bypassSessionGuard?: boolean;
  /** Explicit owner for an intentional transition request. */
  expectedUserId?: string | null;
}

interface ActiveRequest {
  controller: AbortController;
  snapshot: ApiSessionSnapshot;
}

let sessionEpoch = 0;
let sessionUserId: string | null = null;
// The module may be imported by pure utility tests before App mounts. That
// anonymous state is usable (and sends no owner header); App explicitly freezes
// before its first bootstrap, so production account-scoped work never relies
// on this test-friendly initial value.
let sessionFrozen = false;
const activeRequests = new Set<ActiveRequest>();

export function setApiToken(token: string): void {
  apiToken = token;
}

export function getApiToken(): string {
  return apiToken;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function getApiSessionSnapshot(): ApiSessionSnapshot {
  return { epoch: sessionEpoch, userId: sessionUserId };
}

export function getActiveApiRequestCount(): number {
  return activeRequests.size;
}

export function isApiSessionFrozen(): boolean {
  return sessionFrozen;
}

export function isApiSessionCurrent(
  snapshot: ApiSessionSnapshot,
  allowDuringTransition = false,
): boolean {
  return (
    snapshot.epoch === sessionEpoch &&
    snapshot.userId === sessionUserId &&
    (allowDuringTransition || !sessionFrozen)
  );
}

/**
 * Invalidates every in-flight request immediately and freezes new ordinary
 * requests. Keeping `expectedUserId` explicit lets logout still flush the
 * outgoing owner's workspace while all unrelated work is stopped.
 */
export function beginApiSessionTransition(
  expectedUserId: string | null = sessionUserId,
): ApiSessionSnapshot {
  sessionEpoch += 1;
  sessionUserId = expectedUserId;
  sessionFrozen = true;
  for (const active of activeRequests) active.controller.abort();
  activeRequests.clear();
  return getApiSessionSnapshot();
}

/** Unfreezes exactly the transition that produced `snapshot`. */
export function commitApiSession(snapshot: ApiSessionSnapshot): void {
  if (snapshot.epoch !== sessionEpoch || snapshot.userId !== sessionUserId) {
    throw new SessionChangedError();
  }
  sessionFrozen = false;
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

/**
 * A response from an invalidated account/session is control flow, not a user
 * facing request failure. Callers can safely ignore it and, crucially, never
 * apply its payload to the next account.
 */
export class SessionChangedError extends ApiError {
  constructor() {
    super('SESSION_CHANGED', 'The signed-in account changed while the request was running.', 409);
    this.name = 'SessionChangedError';
  }
}

export function isSessionChangedError(error: unknown): error is SessionChangedError {
  return (
    error instanceof SessionChangedError ||
    (error as { code?: string } | null)?.code === 'SESSION_CHANGED'
  );
}

export function assertApiSessionCurrent(
  snapshot: ApiSessionSnapshot,
  allowDuringTransition = false,
): void {
  if (!isApiSessionCurrent(snapshot, allowDuringTransition)) throw new SessionChangedError();
}

/** Headers shared by JSON, SSE, downloads, and the workspace keepalive path. */
export function apiSessionHeaders(
  snapshot: ApiSessionSnapshot = getApiSessionSnapshot(),
  options: Pick<RequestOptions, 'includeExpectedUser' | 'expectedUserId'> = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiToken) headers['x-mylens-token'] = apiToken;
  const expectedUserId =
    options.expectedUserId !== undefined ? options.expectedUserId : snapshot.userId;
  if (options.includeExpectedUser !== false && expectedUserId) {
    headers[EXPECTED_USER_HEADER] = expectedUserId;
  }
  return headers;
}

/**
 * Registers non-api.ts transports (currently POST SSE) with the same epoch
 * invalidation fan-out used by JSON requests.
 */
export function registerApiSessionRequest(
  controller: AbortController,
  snapshot: ApiSessionSnapshot,
  allowDuringTransition = false,
): () => void {
  assertApiSessionCurrent(snapshot, allowDuringTransition);
  const active = { controller, snapshot };
  activeRequests.add(active);
  return () => activeRequests.delete(active);
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

function shouldRevalidateSession(error: ApiError): boolean {
  return (
    (error.status === 401 && (error.code === 'INVALID_TOKEN' || error.code === 'AUTH_REQUIRED')) ||
    error.code === 'SESSION_USER_MISMATCH' ||
    error.code === 'EXPECTED_USER_MISMATCH' ||
    error.code === 'STALE_USER_SESSION'
  );
}

/** Lets transports outside the JSON client trigger the same synchronous freeze/rebootstrap. */
export function handleApiSessionError(error: ApiError): void {
  if (!shouldRevalidateSession(error)) return;
  // The response proves the cookie/token no longer matches this settled client
  // identity. Freeze and abort siblings before asking app-store to probe the
  // cookie; the probe itself is the one transport allowed through this freeze.
  beginApiSessionTransition(sessionUserId);
  unauthorizedHandler?.();
}

function requestSnapshot(options: RequestOptions): ApiSessionSnapshot {
  const snapshot = options.session ?? getApiSessionSnapshot();
  if (!options.bypassSessionGuard) {
    assertApiSessionCurrent(snapshot, options.allowDuringTransition === true);
  }
  return snapshot;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const snapshot = requestSnapshot(options);
  const allowDuringTransition = options.allowDuringTransition === true;
  const bypassSessionGuard = options.bypassSessionGuard === true;
  const assertCurrent = (): void => {
    if (!bypassSessionGuard) assertApiSessionCurrent(snapshot, allowDuringTransition);
  };
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...apiSessionHeaders(snapshot, options),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const unregister = bypassSessionGuard
    ? () => undefined
    : registerApiSessionRequest(controller, snapshot, allowDuringTransition);
  // The server enforces its own 300s ceiling per statement, so the client must
  // wait longer than that or it would abort valid slow queries first.
  const timeoutMs = options.timeoutMs ?? 360_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    assertCurrent();
  } catch (error) {
    // Fetch can reject before a Response exists (network failure, timeout, or
    // an account transition abort). Always remove this request from the epoch
    // registry before translating or rethrowing the error.
    unregister();
    if (!bypassSessionGuard && !isApiSessionCurrent(snapshot, allowDuringTransition)) {
      throw new SessionChangedError();
    }
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
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    try {
      const apiError = await parseApiError(response);
      assertCurrent();
      if (shouldRevalidateSession(apiError)) {
        handleApiSessionError(apiError);
        // The handler freezes synchronously. Turn the original HTTP failure into
        // stale-session control flow so the old screen cannot surface it under B.
        assertCurrent();
      }
      throw apiError;
    } finally {
      unregister();
    }
  }

  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as { data?: T };
      assertCurrent();
      return payload.data as T;
    }
    const text = await response.text();
    assertCurrent();
    return text as T;
  } finally {
    unregister();
  }
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
  const snapshot = requestSnapshot({});
  const controller = new AbortController();
  const unregister = registerApiSessionRequest(controller, snapshot);
  let response: Response;
  try {
    response = await fetch(`/api/reports/${encodeURIComponent(id)}/export?format=${format}`, {
      headers: apiSessionHeaders(snapshot),
      signal: controller.signal,
    });
    assertApiSessionCurrent(snapshot);
    if (!response.ok) {
      const error = await parseApiError(response);
      handleApiSessionError(error);
      assertApiSessionCurrent(snapshot);
      throw error;
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/i);
    const filename = match?.[1] ?? `mylens-report-${id}.${format}`;
    const blob = await response.blob();
    assertApiSessionCurrent(snapshot);
    downloadBlob(filename, blob);
  } catch (error) {
    if (!isApiSessionCurrent(snapshot)) throw new SessionChangedError();
    throw error;
  } finally {
    unregister();
  }
}

/* -------------------------------------------------------------------------- */
/* Cross-tab identity-change signalling                                       */
/* -------------------------------------------------------------------------- */

const SESSION_CHANNEL_NAME = 'mylens.session.v1';
export const SESSION_SIGNAL_STORAGE_KEY = 'mylens.sessionSignal.v1';

export interface SessionSignal {
  id: string;
  source: string;
  at: number;
  userId: string | null;
}

type SessionSignalListener = (signal: SessionSignal) => void;
const sessionSignalListeners = new Set<SessionSignalListener>();
const seenSessionSignals = new Set<string>();
let syncChannel: BroadcastChannel | null = null;
let storageListening = false;

const tabSource = (() => {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
})();

function parseSessionSignal(value: unknown): SessionSignal | null {
  if (typeof value !== 'object' || value === null) return null;
  const signal = value as Partial<SessionSignal>;
  if (
    typeof signal.id !== 'string' ||
    typeof signal.source !== 'string' ||
    typeof signal.at !== 'number' ||
    (typeof signal.userId !== 'string' && signal.userId !== null)
  ) {
    return null;
  }
  return signal as SessionSignal;
}

function deliverSessionSignal(value: unknown): void {
  const signal = parseSessionSignal(value);
  if (!signal || signal.source === tabSource || seenSessionSignals.has(signal.id)) return;
  seenSessionSignals.add(signal.id);
  // The set is tiny, but cap it so a tab left open for months does not grow it forever.
  if (seenSessionSignals.size > 100) {
    const oldest = seenSessionSignals.values().next().value as string | undefined;
    if (oldest) seenSessionSignals.delete(oldest);
  }
  for (const listener of sessionSignalListeners) listener(signal);
}

function ensureSessionSync(): void {
  if (typeof window === 'undefined') return;
  if (!syncChannel && typeof window.BroadcastChannel === 'function') {
    syncChannel = new window.BroadcastChannel(SESSION_CHANNEL_NAME);
    syncChannel.addEventListener('message', (event: MessageEvent<unknown>) => {
      deliverSessionSignal(event.data);
    });
  }
  if (!storageListening) {
    storageListening = true;
    window.addEventListener('storage', (event) => {
      if (event.key !== SESSION_SIGNAL_STORAGE_KEY || !event.newValue) return;
      try {
        deliverSessionSignal(JSON.parse(event.newValue) as unknown);
      } catch {
        // Ignore malformed or unrelated storage writes.
      }
    });
  }
}

export function subscribeSessionSignals(listener: SessionSignalListener): () => void {
  ensureSessionSync();
  sessionSignalListeners.add(listener);
  return () => sessionSignalListeners.delete(listener);
}

/** Notify every other tab after a verified login/setup/logout commit. */
export function broadcastSessionChange(userId: string | null): void {
  if (typeof window === 'undefined') return;
  ensureSessionSync();
  const signal: SessionSignal = {
    id: `${tabSource}:${Date.now()}:${Math.random()}`,
    source: tabSource,
    at: Date.now(),
    userId,
  };
  if (syncChannel) {
    syncChannel.postMessage(signal);
    return;
  }
  // Storage events fire in other documents, not the writer, which is exactly
  // the fallback semantics needed here.
  try {
    window.localStorage.setItem(SESSION_SIGNAL_STORAGE_KEY, JSON.stringify(signal));
  } catch {
    // Cross-tab sync is best effort; focus/pageshow revalidation is the backstop.
  }
}
