/**
 * Screenshots the running app at desktop and phone widths so a change can be
 * proven visually neutral.
 *
 * Requires the server to be running (`npm start`) with the UI built.
 * Usage: node scripts/ui-layout/app-shots.mjs <label>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const LABEL = process.argv[2] ?? 'app';
const OUT = path.resolve('.snapshot');

const SHOTS = [
  { width: 1440, height: 900, name: `${LABEL}-desktop` },
  { width: 390, height: 844, name: `${LABEL}-mobile` },
];

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-app-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function waitForChrome() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
      if (v) return v;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('DevTools endpoint never became ready');
}

async function main() {
  await waitForChrome();
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  // Freeze the clock and stop animations so two captures of the same build
  // are byte-identical. The Connect page renders relative timestamps such as
  // "used 5m ago", which otherwise change between captures.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const FIXED = Date.parse('2026-01-01T12:00:00Z');
      const RealDate = Date;
      class FrozenDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(FIXED);
          else super(...args);
        }
        static now() { return FIXED; }
      }
      Date = FrozenDate;
    `,
  });
  for (const shot of SHOTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 1,
      mobile: shot.width < 768,
    });
    await send('Page.navigate', { url: APP });
    await sleep(2500);
    await send('Runtime.evaluate', {
      expression: `(() => {
        const style = document.createElement('style');
        style.textContent = '*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}';
        document.head.appendChild(style);
      })()`,
    });
    await sleep(300);
    const result = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${shot.name}.png`), Buffer.from(result.data, 'base64'));
    console.log(`captured ${shot.name}.png`);
  }

  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
