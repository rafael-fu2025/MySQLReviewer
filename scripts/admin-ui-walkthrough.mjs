/**
 * One-off: UI walkthrough of the admin layer. Captures setup, admin page,
 * and login screens. Runs against a server whose data has no users yet.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9351;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve('.snapshot');

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-admin-'));
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

  const freeze = () =>
    evalJs(
      `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`,
    );
  const shot = async (name) => {
    await sleep(400);
    const result = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
    console.log(`captured ${name}.png`);
  };
  const type = (selector, value) =>
    evalJs(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        // React tracks its own value setter; assigning the prototype's native
        // setter is the only way a synthetic input event sticks.
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 1. Setup screen
  await send('Page.navigate', { url: APP });
  await sleep(2500);
  console.log('path:', await evalJs('location.pathname'));
  await freeze();
  await shot('auth-setup');

  // 2. Create the admin account through the form
  await type('input[autocomplete="username"]', 'rafael');
  await type('input[placeholder="Your name"]', 'Rafael');
  await type('form input[type="password"]', 'review123');
  await evalJs(
    `(() => {
      const inputs = [...document.querySelectorAll('form input[type="password"]')];
      const confirm = inputs[1];
      if (!confirm) return 'no confirm field';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(confirm, 'review123');
      confirm.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    })()`,
  );
  await evalJs(
    `(() => { document.querySelector('form button[type="submit"]').click(); return true; })()`,
  );
  await sleep(2000);
  console.log('after setup path:', await evalJs('location.pathname'));
  console.log(
    'ui error:',
    await evalJs(`document.querySelector('.callout.danger')?.textContent?.slice(0, 120) ?? 'none'`),
  );

  // 3. Admin page
  await send('Page.navigate', { url: `${APP}/admin` });
  await sleep(2000);
  await freeze();
  await shot('admin-users');

  // 4. Create a member through the modal
  await evalJs(
    `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add member'); if (btn) btn.click(); return Boolean(btn); })()`,
  );
  await sleep(600);
  await type('input[minlength="2"]', 'sherina');
  await type('input[placeholder="Your name"]', 'Sherina');
  const modalPasswords = await evalJs(
    `(() => {
      const pw = [...document.querySelectorAll('input[type="password"]')].pop();
      if (!pw) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(pw, 'member123');
      pw.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
  console.log('member form filled:', modalPasswords);
  await evalJs(
    `(() => { const btn = [...document.querySelectorAll('button[type="submit"]')].pop(); btn.click(); return true; })()`,
  );
  await sleep(1200);

  // 5. Assign sandbox via the modal
  await evalJs(
    `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Assign sandbox'); if (btn) btn.click(); return Boolean(btn); })()`,
  );
  await sleep(600);
  await type('input[placeholder="northwind"]', 'northwind');
  await evalJs(
    `(() => { const btn = [...document.querySelectorAll('button[type="submit"]')].pop(); btn.click(); return true; })()`,
  );
  await sleep(3000);
  await freeze();
  await shot('admin-sandbox-assigned');

  // 6. Sign out → login page
  await evalJs(
    `(() => { const btn = document.querySelector('button[aria-label="Sign out"]'); if (btn) btn.click(); return true; })()`,
  );
  await sleep(1500);
  console.log('after logout path:', await evalJs('location.pathname'));
  await freeze();
  await shot('auth-login');

  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
