/**
 * One-off: capture the Reports screen (empty state) at desktop width.
 * Connects through the first profile card, then navigates to /reports.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-rep-'));
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
const getJson = async (url) => (await fetch(url)).json();

async function main() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await getJson(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(250);
    }
  }
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(page.webSocketDebuggerUrl);
    s.addEventListener('open', () => resolve(s), { once: true });
    s.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;

  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await sleep(3000);
  await evalJs(
    `(() => { const cards = [...document.querySelectorAll('.card')]; for (const c of cards) { const b = [...c.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Connect')); if (b) { b.click(); return true; } } return false; })()`,
  );
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    if ((await evalJs('location.pathname')) === '/workspace') break;
  }
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `${APP}/reports` });
  await sleep(2500);
  await evalJs(
    `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.appendChild(s); })()`,
  );
  await sleep(400);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.resolve('.snapshot', 'reports-desktop.png'), Buffer.from(r.data, 'base64'));
  console.log('captured .snapshot/reports-desktop.png');
  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
