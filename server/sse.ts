import type { Request, Response } from 'express';
import { AppError } from './errors';
import { parseSessionCookie } from './store/sessions';

export interface SseClient {
  send: (event: string, data: unknown) => void;
  close: () => void;
  isClosed: () => boolean;
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Concurrent event streams one session may hold. */
export const MAX_SSE_PER_SESSION = envInt('MYLENS_SSE_PER_SESSION', 5);
/** Concurrent event streams the server hands out in total. */
export const MAX_SSE_TOTAL = envInt('MYLENS_SSE_TOTAL', 50);
/** A peer that stops reading is disconnected once this much is buffered. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Frames queued for a stalled peer before the stream is closed. */
export const MAX_SSE_QUEUE_FRAMES = envInt('MYLENS_SSE_QUEUE_FRAMES', 1000);
/** Bytes queued for a stalled peer before the stream is closed. */
export const MAX_SSE_QUEUE_BYTES = envInt('MYLENS_SSE_QUEUE_BYTES', 1024 * 1024);

const perSessionStreams = new Map<string, number>();
let totalStreams = 0;

function streamKey(req: Request): string {
  const sessionId = parseSessionCookie(req.headers.cookie);
  if (sessionId) return `session:${sessionId}`;
  if (req.user?.id) return `user:${req.user.id}`;
  return `anon:${req.socket?.remoteAddress ?? 'unknown'}`;
}

/** Number of event streams currently open for the given key. */
export function sseStreamCount(key: string): number {
  return perSessionStreams.get(key) ?? 0;
}

/** Number of event streams currently open on the server. */
export function sseTotalStreamCount(): number {
  return totalStreams;
}

/**
 * Opens an event stream. The number of concurrent streams is capped per
 * session and per server: beyond the cap the caller gets a 429 instead of
 * another long-lived connection.
 */
export function openSse(req: Request, res: Response): SseClient {
  const key = streamKey(req);
  if ((perSessionStreams.get(key) ?? 0) >= MAX_SSE_PER_SESSION || totalStreams >= MAX_SSE_TOTAL) {
    throw new AppError(
      'TOO_MANY_STREAMS',
      'Too many open event streams. Close the running ones before starting a new one.',
      429,
    );
  }
  perSessionStreams.set(key, (perSessionStreams.get(key) ?? 0) + 1);
  totalStreams += 1;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  let backpressured = false;
  /** Frames held while the socket is backed up, in send order. */
  const queue: { payload: string; bytes: number }[] = [];
  let queuedBytes = 0;

  function release(): void {
    const current = perSessionStreams.get(key) ?? 0;
    if (current <= 1) perSessionStreams.delete(key);
    else perSessionStreams.set(key, current - 1);
    totalStreams = Math.max(0, totalStreams - 1);
  }

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    queue.length = 0;
    queuedBytes = 0;
    release();
  }

  /** Tells the peer the stream is ending and why, then closes it. */
  function abortWithOverflow(): void {
    if (!closed && !res.writableEnded) {
      // Written straight to the socket, past the full queue, so the peer
      // learns why the stream ended instead of seeing a truncated one.
      res.write(
        `event: error\ndata: ${JSON.stringify({
          code: 'SSE_OVERFLOW',
          message: 'The event stream fell too far behind and was closed.',
        })}\n\n`,
      );
    }
    close();
  }

  /** Drains queued frames; stops as soon as the socket backs up again. */
  function flushQueue(): void {
    if (closed || res.writableEnded) return;
    while (queue.length > 0) {
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        close();
        return;
      }
      const frame = queue.shift();
      if (!frame) break;
      queuedBytes -= frame.bytes;
      // A false return only means "buffered, continue later": the frame has
      // been handed to the socket and will reach the peer.
      if (!res.write(frame.payload)) return;
    }
    backpressured = false;
  }

  /**
   * Writes one frame. While the socket is backed up the frame is queued so a
   * briefly slow peer keeps receiving every chunk in order; a peer that
   * stays stalled past the queue bounds gets an explicit error frame and a
   * closed stream instead of a silently corrupted one, and a peer that never
   * reads at all is disconnected once 1 MB sits in the socket buffer.
   */
  function write(payload: string): boolean {
    if (closed || res.writableEnded) return false;
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      close();
      return false;
    }
    if (backpressured) return enqueue(payload);
    const flushed = res.write(payload);
    if (!flushed) backpressured = true;
    return true;
  }

  /** Holds a frame for the drain; bounded so a stalled peer cannot pile up. */
  function enqueue(payload: string): boolean {
    const bytes = Buffer.byteLength(payload);
    if (queue.length >= MAX_SSE_QUEUE_FRAMES || queuedBytes + bytes > MAX_SSE_QUEUE_BYTES) {
      abortWithOverflow();
      return false;
    }
    queue.push({ payload, bytes });
    queuedBytes += bytes;
    return true;
  }

  function close(): void {
    if (res.writableEnded) {
      cleanup();
      return;
    }
    cleanup();
    res.end();
  }

  const heartbeat = setInterval(() => {
    write(': ping\n\n');
  }, 15_000);

  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('drain', flushQueue);

  return {
    send(event, data) {
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close,
    isClosed() {
      return closed;
    },
  };
}
