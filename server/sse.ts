import type { Request, Response } from 'express';

export interface SseClient {
  send: (event: string, data: unknown) => void;
  close: () => void;
  isClosed: () => boolean;
}

export function openSse(req: Request, res: Response): SseClient {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };

  req.on('aborted', cleanup);
  res.on('close', cleanup);

  return {
    send(event, data) {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (res.writableEnded) return;
      cleanup();
      res.end();
    },
    isClosed() {
      return closed;
    },
  };
}
