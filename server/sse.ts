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
    release();
  }

  /**
   * Writes one frame. A peer that does not read is dropped instead of being
   * buffered without limit: while the socket is backed up the frames are
   * skipped, and a peer that stays far behind is disconnected.
   */
  function write(payload: string): boolean {
    if (closed || res.writableEnded) return false;
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      close();
      return false;
    }
    if (backpressured) return false;
    const flushed = res.write(payload);
    if (!flushed) backpressured = true;
    return flushed;
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
  res.on('drain', () => {
    backpressured = false;
  });

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
