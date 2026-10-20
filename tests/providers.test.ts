import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOpenAi, streamOpenAi } from '../server/ai/openai';
import { completeAnthropic } from '../server/ai/anthropic';
import { completeGoogle } from '../server/ai/google';
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

    const result = await completeOpenAi(
      testProvider,
      'secret',
      [{ role: 'user', content: 'Hi' }],
      { maxTokens: 10 },
    );

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
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const deltas: string[] = [];
    const result = await streamOpenAi(
      testProvider,
      null,
      [{ role: 'user', content: 'Hi' }],
      { onDelta: (text) => deltas.push(text) },
    );

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
    const result = await completeAnthropic(provider, 'secret', [
      { role: 'user', content: 'Hi' },
    ]);

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
    const result = await completeGoogle(provider, 'secret', [
      { role: 'user', content: 'Hi' },
    ]);

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
      completeOpenAi(testProvider, 'super-secret', [
        { role: 'user', content: 'Hi' },
      ]),
    ).rejects.toMatchObject({
      code: 'AI_AUTH',
      message: expect.not.stringContaining('super-secret'),
    });
  });
});
