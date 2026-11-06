/**
 * One-off: screenshot the Connect page as the demo member (sherina) to verify
 * the member view of their assigned connection.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9353;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-member-'));
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
  const type = (selector, value) =>
    evalJs(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
  const shot = async (name) => {
    await sleep(400);
    const result = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.resolve('.snapshot', `${name}.png`), Buffer.from(result.data, 'base64'));
    console.log(`captured ${name}.png`);
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1024,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `${APP}/login` });
  await sleep(2500);
  await type('input[autocomplete="username"]', 'sherina');
  await type('input[type="password"]', 'member123');
  await evalJs(
    `(() => { document.querySelector('form button[type="submit"]').click(); return true; })()`,
  );
  await sleep(2500);
  console.log('path after login:', await evalJs('location.pathname'));
  await evalJs(
    `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`,
  );
  await shot('member-connect');

  // Also verify the connected workspace shows the sandbox only.
  await evalJs(
    `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Connect')); if (btn) btn.click(); return true; })()`,
  );
  await sleep(3500);
  console.log('path after connect:', await evalJs('location.pathname'));
  const dbInfo = await evalJs(
    `(() => { const combo = document.querySelector('.combo-button'); return combo ? combo.textContent.slice(0, 60) : 'no combobox'; })()`,
  );
  console.log('database combobox:', dbInfo);
  await shot('member-workspace');

  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
