import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { MAX_SSE_QUEUE_BYTES, MAX_SSE_QUEUE_FRAMES, openSse } from '../server/sse';

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableEnded = false;
  writableLength = 0;
  /** When false the socket reports back-pressure on every write. */
  acceptsWrites = true;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  flushHeaders(): void {
    // Nothing to flush in the fake.
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.acceptsWrites;
  }

  end(): void {
    this.writableEnded = true;
    this.emit('close');
  }
}

function fakeRequest(cookie: string): Request {
  const req = new EventEmitter() as unknown as Request;
  Object.assign(req, {
    headers: { cookie },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return req;
}

describe('the event stream queue for stalled peers', () => {
  it('flushes queued frames in send order and only until the socket backs up again', () => {
    const res = new FakeResponse();
    res.acceptsWrites = false;
    const client = openSse(fakeRequest('mylens_session=queue-flush'), res as unknown as Response);
    try {
      client.send('first', { n: 1 });
      client.send('second', { n: 2 });
      client.send('third', { n: 3 });
      expect(res.chunks.length).toBe(1);

      // The socket only takes one frame before backing up again: the queue
      // keeps the rest instead of dropping them.
      res.emit('drain');
      expect(res.chunks.length).toBe(2);
      client.send('fourth', { n: 4 });
      expect(res.chunks.length).toBe(2); // still queued

      // The peer catches up: everything queued is flushed, and new frames
      // are written straight through again.
      res.acceptsWrites = true;
      res.emit('drain');
      expect(res.chunks.length).toBe(4);
      expect(res.chunks.map((chunk) => Number(/"n":(\d+)/.exec(chunk)?.[1]))).toEqual([1, 2, 3, 4]);
      client.send('fifth', { n: 5 });
      expect(res.chunks.length).toBe(5);
    } finally {
      client.close();
    }
  });

  it('closes the stream with an explicit error frame once the frame bound is exceeded', () => {
    const res = new FakeResponse();
    res.acceptsWrites = false;
    const client = openSse(
      fakeRequest('mylens_session=frame-overflow'),
      res as unknown as Response,
    );
    try {
      for (let index = 0; index <= MAX_SSE_QUEUE_FRAMES; index += 1) {
        client.send('progress', { n: index });
      }
      // The first frame went straight to the socket, so the queue now holds
      // exactly MAX_SSE_QUEUE_FRAMES frames: full, but not yet over the bound.
      expect(client.isClosed()).toBe(false);

      // One frame past the bound: the peer gets an explicit error frame and
      // a closed stream instead of a silently truncated one.
      client.send('progress', { n: MAX_SSE_QUEUE_FRAMES + 1 });
      expect(client.isClosed()).toBe(true);
      expect(res.writableEnded).toBe(true);
      const last = res.chunks[res.chunks.length - 1];
      expect(last).toContain('event: error');
      expect(last).toContain('SSE_OVERFLOW');
      expect(last).toContain('fell too far behind');
    } finally {
      if (!client.isClosed()) client.close();
    }
  });

  it('closes the stream once the queued bytes exceed the byte bound', () => {
    const res = new FakeResponse();
    res.acceptsWrites = false;
    const client = openSse(fakeRequest('mylens_session=byte-overflow'), res as unknown as Response);
    try {
      // Two ~600 KB frames: each one alone fits under the queue bound, two
      // together do not.
      const big = 'x'.repeat(600_000);
      expect(MAX_SSE_QUEUE_BYTES).toBeGreaterThan(600_050);
      expect(2 * MAX_SSE_QUEUE_BYTES).toBeGreaterThan(2 * 600_000);
      client.send('big', { text: big });
      client.send('big', { text: big });
      expect(client.isClosed()).toBe(false);

      client.send('big', { text: big });
      expect(client.isClosed()).toBe(true);
      const last = res.chunks[res.chunks.length - 1];
      expect(last).toContain('event: error');
      expect(last).toContain('SSE_OVERFLOW');
    } finally {
      if (!client.isClosed()) client.close();
    }
  });

  it('still disconnects a peer once 1 MB is buffered in the socket itself', () => {
    const res = new FakeResponse();
    res.acceptsWrites = true;
    res.writableLength = 1024 * 1024 + 1; // the socket buffer is over the cap
    const client = openSse(fakeRequest('mylens_session=socket-cap'), res as unknown as Response);
    try {
      client.send('progress', { n: 1 });
      expect(client.isClosed()).toBe(true);
      expect(res.writableEnded).toBe(true);
    } finally {
      if (!client.isClosed()) client.close();
    }
  });

  it('drops its queue when the stream is closed', () => {
    const res = new FakeResponse();
    res.acceptsWrites = false;
    const client = openSse(fakeRequest('mylens_session=closed-queue'), res as unknown as Response);
    client.send('first', { n: 1 });
    client.send('second', { n: 2 });
    client.close();
    expect(client.isClosed()).toBe(true);

    // A drain after the close must not resurrect queued frames.
    res.acceptsWrites = true;
    res.emit('drain');
    expect(res.chunks.length).toBe(1);
  });
});
