import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  beginApiSessionTransition,
  commitApiSession,
  EXPECTED_USER_HEADER,
  getActiveApiRequestCount,
  getApiSessionSnapshot,
  SessionChangedError,
  setApiToken,
  setUnauthorizedHandler,
  subscribeSessionSignals,
} from '@/lib/api';

function jsonResponse<T>(data: T): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  postMessage(_value: unknown): void {}

  emit(value: unknown): void {
    for (const listener of this.listeners) listener({ data: value } as MessageEvent<unknown>);
  }
}

describe('client account epoch transport guard', () => {
  beforeEach(() => {
    const current = getApiSessionSnapshot();
    const anonymous = beginApiSessionTransition(null);
    expect(anonymous.epoch).toBeGreaterThan(current.epoch);
    commitApiSession(anonymous);
    setApiToken('');
  });

  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.restoreAllMocks();
  });

  it('adds the expected-user header to authenticated JSON requests', async () => {
    const a = beginApiSessionTransition('user-a');
    setApiToken('token-a');
    commitApiSession(a);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

    await api.get('/api/private');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get(EXPECTED_USER_HEADER)).toBe('user-a');
    expect(EXPECTED_USER_HEADER).toBe('x-mylens-expected-user-id');
    expect(headers.get('x-mylens-token')).toBe('token-a');
  });

  it('rejects a late A response after B advances the epoch', async () => {
    const a = beginApiSessionTransition('user-a');
    commitApiSession(a);
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const request = api.get<{ owner: string }>('/api/private');
    const b = beginApiSessionTransition('user-b');
    commitApiSession(b);
    resolveFetch(jsonResponse({ owner: 'user-a' }));

    await expect(request).rejects.toBeInstanceOf(SessionChangedError);
  });

  it('freezes ordinary requests until a verified transition commits', async () => {
    beginApiSessionTransition('user-b');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(api.get('/api/private')).rejects.toBeInstanceOf(SessionChangedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('freezes and invokes reconciliation on a stale-user response', async () => {
    const a = beginApiSessionTransition('user-a');
    commitApiSession(a);
    const reconcile = vi.fn();
    setUnauthorizedHandler(reconcile);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'STALE_USER_SESSION', message: 'The cookie belongs to another user.' },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(api.get('/api/private')).rejects.toBeInstanceOf(SessionChangedError);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(getApiSessionSnapshot().userId).toBe('user-a');
    await expect(api.get('/api/blocked')).rejects.toBeInstanceOf(SessionChangedError);
  });

  it('unregisters active requests after a network failure', async () => {
    const a = beginApiSessionTransition('user-a');
    commitApiSession(a);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    expect(getActiveApiRequestCount()).toBe(0);
    await expect(api.get('/api/private')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(getActiveApiRequestCount()).toBe(0);
  });

  it('unregisters an active request when an identity transition aborts it', async () => {
    const a = beginApiSessionTransition('user-a');
    commitApiSession(a);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const request = api.get('/api/private');
    expect(getActiveApiRequestCount()).toBe(1);
    const b = beginApiSessionTransition('user-b');
    commitApiSession(b);
    await expect(request).rejects.toBeInstanceOf(SessionChangedError);
    expect(getActiveApiRequestCount()).toBe(0);
  });

  it('probes bootstrap without freezing or invalidating a settled session', async () => {
    const a = beginApiSessionTransition('user-a');
    commitApiSession(a);
    const before = getApiSessionSnapshot();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ currentUser: { id: 'user-a' } }));

    await api.get('/api/bootstrap', {
      session: before,
      includeExpectedUser: false,
      bypassSessionGuard: true,
    });

    expect(getApiSessionSnapshot()).toEqual(before);
    expect(getActiveApiRequestCount()).toBe(0);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has(EXPECTED_USER_HEADER)).toBe(false);
  });

  it('allows bootstrap identity discovery without an expected-user header', async () => {
    const transition = beginApiSessionTransition('user-a');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ currentUser: { id: 'user-b' } }));

    await api.get('/api/bootstrap', {
      session: transition,
      allowDuringTransition: true,
      includeExpectedUser: false,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has(EXPECTED_USER_HEADER)).toBe(false);
  });
});

describe('cross-tab session signals', () => {
  it('delivers a valid BroadcastChannel identity signal once and ignores this tab', () => {
    FakeBroadcastChannel.instances.length = 0;
    const storageListeners: Array<(event: StorageEvent) => void> = [];
    const windowStub = {
      BroadcastChannel: FakeBroadcastChannel,
      addEventListener: (type: string, listener: EventListener) => {
        if (type === 'storage') storageListeners.push(listener as (event: StorageEvent) => void);
      },
      localStorage: { setItem: vi.fn() },
    };
    vi.stubGlobal('window', windowStub);
    const received: Array<string | null> = [];
    const unsubscribe = subscribeSessionSignals((signal) => received.push(signal.userId));
    const channel = FakeBroadcastChannel.instances[0];
    expect(channel?.name).toBe('mylens.session.v1');

    channel.emit({ id: 'other:1', source: 'other-tab', at: Date.now(), userId: 'user-b' });
    channel.emit({ id: 'other:1', source: 'other-tab', at: Date.now(), userId: 'user-b' });
    channel.emit({ id: 'bad', source: 'other-tab', at: 'not-a-number', userId: 'user-c' });

    expect(received).toEqual(['user-b']);
    expect(storageListeners).toHaveLength(1);
    unsubscribe();
    vi.unstubAllGlobals();
  });
});
