/**
 * One-off: drive the real UI into the SQL Lab screen and capture it.
 * Connects via the first profile card (XAMPP root/empty), waits for the
 * workspace, then navigates to /practice and screenshots desktop + mobile.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve('.snapshot');

const SHOTS = [
  { width: 1440, height: 900, name: 'lab-desktop' },
  { width: 1180, height: 900, name: 'lab-narrow' },
  { width: 390, height: 844, name: 'lab-mobile' },
];

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-lab-'));
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
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await sleep(3000);

  // Click the first profile card's primary Connect button.
  const clicked = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    for (const card of cards) {
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Connect'));
      if (btn) { btn.click(); return card.querySelector('span')?.textContent ?? 'card'; }
    }
    return null;
  })()`);
  console.log('clicked connect on:', clicked);
  if (!clicked) throw new Error('no Connect button found — is the connect page rendered?');

  // Wait for the workspace to appear (connected state).
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const url = await evalJs('location.pathname');
    if (url === '/workspace') break;
  }
  console.log('pathname now:', await evalJs('location.pathname'));

  await send('Page.navigate', { url: `${APP}/practice` });
  await sleep(4000);

  // Open the most recent challenge set if the empty state is showing.
  // LAB_NO_OPEN=1 skips this to verify the hub is the landing page.
  const opened = process.env.LAB_NO_OPEN
    ? 'skipped (LAB_NO_OPEN)'
    : await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /\\d+ challenges/.test(b.textContent));
    if (btn) { btn.click(); return btn.textContent.trim().slice(0, 50); }
    return null;
  })()`);
  console.log('opened set:', opened);
  await sleep(4500);
  const stageInfo = await evalJs(`(() => {
    const q = (s) => document.querySelector(s);
    const grid = [...document.querySelectorAll('div')].find((d) => d.className?.includes?.('grid') && d.className?.includes?.('lg:grid-cols'));
    return JSON.stringify({
      path: location.pathname,
      hasStage: Boolean(q('.practice-stage')),
      hasNav: Boolean(q('.practice-nav')),
      hasEditor: Boolean(q('.editor-host')),
      gridClass: grid ? grid.className.slice(0, 140) : null,
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    });
  })()`);
  console.log('stage:', stageInfo);

  for (const shot of SHOTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 1,
      mobile: shot.width < 768,
    });
    await sleep(900);
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
