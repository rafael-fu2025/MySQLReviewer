import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOpenAi, streamOpenAi } from '../server/ai/openai';
import { completeAnthropic } from '../server/ai/anthropic';
import { completeGoogle } from '../server/ai/google';
import { decryptProviderHeaders, encryptProviderHeaders } from '../server/store/providers';
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

  it('parses a Google Gemini response and appends the API key', async () => {
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
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(':generateContent');
    expect(String(url)).toContain('key=secret');
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
