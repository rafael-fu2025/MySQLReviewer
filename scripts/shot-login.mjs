/** One-off: capture the login page into the image cache for visual review. */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9375;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const THEME = process.env.SHOT_THEME ?? 'dark';
const NAME = process.env.SHOT_NAME ?? 'capture';
const OUT = process.env.SHOT_DIR ?? '.snapshot';

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-shot-'));
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(process.env.SHOT_W ?? 1440),
    height: Number(process.env.SHOT_H ?? 900),
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `${APP}/login` });
  for (let i = 0; i < 80; i += 1) {
    if (await evalJs(`Boolean(document.querySelector('.auth-page'))`)) break;
    await sleep(100);
  }
  if (!(await evalJs(`Boolean(document.querySelector('.auth-page'))`))) {
    throw new Error('Login page did not load');
  }
  await evalJs(`document.documentElement.dataset.theme = '${THEME}'`);
  await sleep(1400);
  const result = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.resolve(OUT, `${NAME}.png`);
  writeFileSync(out, Buffer.from(result.data, 'base64'));
  console.log(out);
  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
