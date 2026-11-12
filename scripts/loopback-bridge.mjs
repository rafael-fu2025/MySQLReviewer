import net from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const CONNECT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

function parsePort(value, fallback = DEFAULT_PORT) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) return fallback;
  return parsed;
}

const upstreamHost = process.argv[2]?.trim();
const port = parsePort(process.argv[3]);

if (!upstreamHost || net.isIP(upstreamHost) !== 4 || upstreamHost.startsWith('127.')) {
  console.error('[mylens] bridge: expected a non-loopback LAN IPv4 address.');
  process.exit(1);
}

const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect({ host: upstreamHost, port });
  sockets.add(client);
  sockets.add(upstream);
  upstream.setTimeout(CONNECT_TIMEOUT_MS);

  let connected = false;
  const closePair = () => {
    client.destroy();
    upstream.destroy();
  };
  const forget = (socket) => {
    sockets.delete(socket);
  };

  upstream.once('connect', () => {
    connected = true;
    upstream.setTimeout(0);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.once('timeout', closePair);
  client.on('error', closePair);
  upstream.on('error', (error) => {
    if (!connected) {
      console.error(
        `[mylens] bridge: cannot reach http://${upstreamHost}:${port} (${error.message})`,
      );
    }
    closePair();
  });
  client.on('close', () => forget(client));
  upstream.on('close', () => forget(upstream));
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[mylens] bridge: http://${LOOPBACK_HOST}:${port} is already in use.`);
  } else {
    console.error(`[mylens] bridge: ${error.message}`);
  }
  process.exit(1);
});

server.listen(port, LOOPBACK_HOST, () => {
  console.log(
    `[mylens] tunnel bridge: http://${LOOPBACK_HOST}:${port} -> http://${upstreamHost}:${port}`,
  );
  if (process.send) process.send({ type: 'ready' });
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('message', (message) => {
  if (message?.type === 'shutdown') shutdown();
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('disconnect', shutdown);
