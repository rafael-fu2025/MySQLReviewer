import { spawn } from 'node:child_process';
import net from 'node:net';

const DEFAULT_PORT = 8787;
const LOOPBACK_HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;

function parsePort(value, fallback = DEFAULT_PORT) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) return fallback;
  return parsed;
}

function isLanIpv4(value) {
  if (net.isIP(value) !== 4 || value.startsWith('127.')) return false;
  return value.split('.').every((octet) => Number.parseInt(octet, 10) <= 255);
}

function waitForBridge(bridge) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error('Timed out while starting the loopback bridge.')),
      READY_TIMEOUT_MS,
    );

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      bridge.off('message', onMessage);
      bridge.off('error', onError);
      bridge.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message) => {
      if (message?.type === 'ready') finish();
    };
    const onError = (error) => finish(error);
    const onExit = (code) =>
      finish(new Error(`Loopback bridge exited before startup (code ${code ?? 'unknown'}).`));

    bridge.on('message', onMessage);
    bridge.on('error', onError);
    bridge.on('exit', onExit);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

const lanIp = process.argv[2]?.trim();
const port = parsePort(process.env.MYLENS_PORT);

if (!lanIp || !isLanIpv4(lanIp)) {
  console.error('[mylens] launcher: expected a non-loopback LAN IPv4 address.');
  process.exit(1);
}

const bridge = spawn(process.execPath, ['scripts/loopback-bridge.mjs', lanIp, String(port)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});

let app = null;
let shuttingDown = false;
let exitCode = 1;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (app && app.exitCode === null && app.signalCode === null) {
    app.kill('SIGTERM');
    await waitForExit(app, EXIT_TIMEOUT_MS);
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
  }

  if (bridge.exitCode === null && bridge.signalCode === null) {
    if (bridge.connected) bridge.send({ type: 'shutdown' });
    await waitForExit(bridge, EXIT_TIMEOUT_MS);
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL');
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await waitForBridge(bridge);
  app = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });

  app.once('error', (error) => {
    console.error(`[mylens] launcher: could not start MyLens (${error.message})`);
    exitCode = 1;
    void shutdown();
  });
  app.once('exit', (code, signal) => {
    exitCode = code ?? (signal ? 1 : 0);
    void shutdown();
  });
  bridge.once('exit', (code) => {
    if (shuttingDown) return;
    console.error(
      `[mylens] launcher: loopback bridge stopped unexpectedly (code ${code ?? 'unknown'}).`,
    );
    exitCode = 1;
    void shutdown();
  });
} catch (error) {
  console.error(`[mylens] launcher: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
  await shutdown();
}
