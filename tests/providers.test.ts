import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOpenAi, streamOpenAi } from '../server/ai/openai';
import { completeAnthropic } from '../server/ai/anthropic';
import { completeGoogle, listGoogleModels } from '../server/ai/google';
import { complete, resetAiLimits } from '../server/ai';
import { assertProviderUrl, extractJsonPayload, readBoundedText, readSse } from '../server/ai/http';
import {
  decryptProviderHeaders,
  encryptProviderHeaders,
  createProvider,
} from '../server/store/providers';
import { canReuseStoredPassword } from '../server/routes/connections';
import { testProvider } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AI provider adapters', () => {
  it('parses an OpenAI-compatible completion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Hello from the model' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeOpenAi(testProvider, 'secret', [{ role: 'user', content: 'Hi' }], {
      maxTokens: 10,
    });

    expect(result.text).toBe('Hello from the model');
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret',
    });
  });

  it('streams OpenAI-compatible deltas', async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'),
        );
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const deltas: string[] = [];
    const result = await streamOpenAi(testProvider, null, [{ role: 'user', content: 'Hi' }], {
      onDelta: (text) => deltas.push(text),
    });

    expect(result.text).toBe('Hello');
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('parses an Anthropic Messages response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'Claude' },
            ],
            usage: { input_tokens: 7, output_tokens: 3 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const provider = {
      ...testProvider,
      type: 'anthropic' as const,
      baseUrl: 'https://api.anthropic.test',
      model: 'claude-test',
    };
    const result = await completeAnthropic(provider, 'secret', [{ role: 'user', content: 'Hi' }]);

    expect(result.text).toBe('Hello Claude');
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
  });

  it('parses a Google Gemini response and sends the API key in a header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Hello Gemini' }] } }],
          usageMetadata: {
            promptTokenCount: 4,
            candidatesTokenCount: 2,
            totalTokenCount: 6,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = {
      ...testProvider,
      type: 'google' as const,
      baseUrl: 'https://generativelanguage.test/v1beta',
      model: 'gemini-test',
    };
    const result = await completeGoogle(provider, 'secret', [{ role: 'user', content: 'Hi' }]);

    expect(result.text).toBe('Hello Gemini');
    expect(result.usage?.totalTokens).toBe(6);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(':generateContent');
    // F-35: the key must not travel in the query string.
    expect(String(url)).not.toContain('secret');
    expect(String(url)).not.toContain('key=');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'secret' });
  });

  it('F-37 refuses a model name that would walk out of the request path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const provider = {
      ...testProvider,
      type: 'google' as const,
      baseUrl: 'https://generativelanguage.test/v1beta',
      model: '../../admin',
    };

    await expect(
      completeGoogle(provider, 'secret', [{ role: 'user', content: 'Hi' }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('F-37 refuses a model name that contains a path separator', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const provider = {
      ...testProvider,
      type: 'google' as const,
      baseUrl: 'https://generativelanguage.test/v1beta',
      model: 'models/gemini-test',
    };

    await expect(
      completeGoogle(provider, 'secret', [{ role: 'user', content: 'Hi' }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('F-35 keeps the Google key out of the model listing URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ models: [{ name: 'models/gemini-test' }] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = {
      ...testProvider,
      type: 'google' as const,
      baseUrl: 'https://generativelanguage.test/v1beta',
      model: 'gemini-test',
    };
    const models = await listGoogleModels(provider, 'secret');

    expect(models).toEqual(['gemini-test']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('secret');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'secret' });
  });

  it('maps provider errors without leaking the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      completeOpenAi(testProvider, 'super-secret', [{ role: 'user', content: 'Hi' }]),
    ).rejects.toMatchObject({
      code: 'AI_AUTH',
      message: expect.not.stringContaining('super-secret'),
    });
  });
});

describe('provider custom header storage', () => {
  it('encrypts header values at rest and decrypts them on read', async () => {
    const stored = await encryptProviderHeaders({
      'X-Gateway-Key': 'gateway-secret',
      'X-Org': '',
    });

    expect(stored['X-Gateway-Key']).not.toBe('gateway-secret');
    expect(stored['X-Gateway-Key'].startsWith('v1:')).toBe(true);
    expect(stored['X-Org']).toBe('');
    expect(await decryptProviderHeaders(stored)).toEqual({
      'X-Gateway-Key': 'gateway-secret',
      'X-Org': '',
    });
  });

  it('reads legacy plaintext headers and migrates them on the next save', async () => {
    const legacy = { 'X-Legacy': 'plain-token' };
    expect(await decryptProviderHeaders(legacy)).toEqual(legacy);

    const migrated = await encryptProviderHeaders(legacy);
    expect(migrated['X-Legacy']).not.toBe('plain-token');
    expect(migrated['X-Legacy'].startsWith('v1:')).toBe(true);
    expect(await decryptProviderHeaders(migrated)).toEqual(legacy);
  });

  it('handles missing header maps', async () => {
    expect(await encryptProviderHeaders(undefined)).toEqual({});
    expect(await decryptProviderHeaders(undefined)).toEqual({});
  });
});

describe('connection test credential reuse', () => {
  const stored = { host: 'db.internal', port: 3306, user: 'app', socketPath: null };

  it('reuses the saved password for the same target', () => {
    expect(
      canReuseStoredPassword(stored, {
        host: ' DB.internal ',
        port: 3306,
        user: 'app',
      }),
    ).toBe(true);
  });

  it('refuses to reuse it for a different host, port, user, or socket', () => {
    expect(canReuseStoredPassword(stored, { host: 'evil.test', port: 3306, user: 'app' })).toBe(
      false,
    );
    expect(canReuseStoredPassword(stored, { host: 'db.internal', port: 3307, user: 'app' })).toBe(
      false,
    );
    expect(canReuseStoredPassword(stored, { host: 'db.internal', port: 3306, user: 'root' })).toBe(
      false,
    );
    expect(
      canReuseStoredPassword(stored, {
        host: 'db.internal',
        port: 3306,
        user: 'app',
        socketPath: '/tmp/mysql.sock',
      }),
    ).toBe(false);
  });
});

describe('F-12 the provider base URL is validated', () => {
  it('accepts a plain http(s) URL', () => {
    expect(assertProviderUrl('https://api.example.test/v1').hostname).toBe('api.example.test');
    expect(assertProviderUrl('http://127.0.0.1:11434/v1').hostname).toBe('127.0.0.1');
  });

  it('refuses a URL that is not http(s)', () => {
    expect(() => assertProviderUrl('file:///etc/passwd')).toThrow();
    expect(() => assertProviderUrl('gopher://example.test')).toThrow();
    expect(() => assertProviderUrl('not a url')).toThrow();
  });

  it('refuses credentials, a query string and a metadata address', () => {
    expect(() => assertProviderUrl('https://user:pass@api.example.test/v1')).toThrow();
    expect(() => assertProviderUrl('https://api.example.test/v1?key=abc')).toThrow();
    expect(() => assertProviderUrl('https://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => assertProviderUrl('https://0.0.0.0/v1')).toThrow();
  });

  it('refuses to store a provider with an unsafe base URL', async () => {
    await expect(
      createProvider({
        name: 'Unsafe provider',
        type: 'openai',
        baseUrl: 'https://169.254.169.254/latest',
        model: 'test-model',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('F-15 a provider response cannot exhaust the memory', () => {
  it('refuses a body that is larger than the ceiling', async () => {
    const response = new Response('x'.repeat(4096), { status: 200 });
    await expect(readBoundedText(response, 1024)).rejects.toMatchObject({
      code: 'AI_RESPONSE_TOO_LARGE',
    });
  });

  it('reads a body that fits', async () => {
    const response = new Response('hello', { status: 200 });
    expect(await readBoundedText(response, 1024)).toBe('hello');
  });

  it('refuses a stream that grows past the ceiling', async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('a'.repeat(64)));
        controller.enqueue(encoder.encode('b'.repeat(64)));
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200 });
    await expect(readSse(response, () => undefined, { maxBytes: 32 })).rejects.toMatchObject({
      code: 'AI_RESPONSE_TOO_LARGE',
    });
  });
});

describe('F-13 a malformed provider answer is repaired locally', () => {
  it('extracts the JSON object out of a wrapped answer', () => {
    const answer = 'Here is the review:\n{"verdict":"pass","summary":"ok"}';
    expect(extractJsonPayload(answer)).toBe('{"verdict":"pass","summary":"ok"}');
  });

  it('leaves a prose answer untouched', () => {
    const answer = 'The query joins three tables; watch the fan-out.';
    expect(extractJsonPayload(answer)).toBe(answer);
  });

  it('returns the JSON object to the caller instead of the wrapped text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Here is the review:\n{"verdict":"pass","summary":"ok"}',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await complete(testProvider, 'secret', [{ role: 'user', content: 'Hi' }]);

    expect(result.text).toBe('{"verdict":"pass","summary":"ok"}');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('F-17 the AI endpoints are rate limited and bounded', () => {
  afterEach(() => {
    resetAiLimits();
  });

  it('refuses more than sixty provider calls per minute', async () => {
    resetAiLimits();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    for (let index = 0; index < 60; index += 1) {
      await complete(testProvider, 'secret', [{ role: 'user', content: 'Hi' }]);
    }

    await expect(
      complete(testProvider, 'secret', [{ role: 'user', content: 'Hi' }]),
    ).rejects.toMatchObject({ code: 'AI_RATE_LIMIT' });
  });

  it('refuses to queue more than eight provider calls', async () => {
    resetAiLimits();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await gate;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < 12; index += 1) {
      pending.push(
        complete(testProvider, 'secret', [{ role: 'user', content: 'Hi' }]).catch(() => undefined),
      );
    }

    await expect(
      complete(testProvider, 'secret', [{ role: 'user', content: 'Hi' }]),
    ).rejects.toMatchObject({ code: 'AI_BUSY' });

    release();
    await Promise.all(pending);
  });
});
