/**
 * One-off: verify the AI provider shortcut is hidden from members in the
 * sidebar footer and the phone "More" sheet, and still visible to admins.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9365;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve('.snapshot', 'ai-visibility');

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-ai-'));
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

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function main() {
  mkdirSync(OUT, { recursive: true });
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
    const result = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
    console.log(`      captured ${name}.png`);
  };
  const setWidth = async (width) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);
  };
  const footerAiButtons = () =>
    evalJs(`(() => [...document.querySelectorAll('.sidebar-footer .nav-item')].length)()`);

  const login = async (username, password) => {
    await send('Page.navigate', { url: `${APP}/login` });
    await sleep(2500);
    await type('input[autocomplete="username"]', username);
    await type('input[type="password"]', password);
    await evalJs(
      `(() => { document.querySelector('form button[type="submit"]').click(); return true; })()`,
    );
    await sleep(2500);
    await evalJs(
      `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Connect')); if (btn) btn.click(); return true; })()`,
    );
    await sleep(3500);
  };

  await send('Page.enable');

  // --- Member: no AI entry anywhere ---
  await login('sherina', 'member123');
  console.log('member path:', await evalJs('location.pathname'));

  await setWidth(1280);
  const memberCount = await footerAiButtons();
  await shot('member-sidebar');
  check('member: no AI button in sidebar footer', memberCount === 0, `${memberCount} nav-item(s)`);

  await setWidth(400);
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('.bottom-nav button')].find((x) => x.textContent.includes('More')); if (b) b.click(); return true; })()`,
  );
  await sleep(600);
  const memberSheet = await evalJs(
    `(() => ({
      open: Boolean(document.querySelector('[role="dialog"]')),
      hasAi: [...document.querySelectorAll('[role="dialog"] .sheet-item')].some((b) => Boolean(b.querySelector('.lucide-sparkles'))),
      items: [...document.querySelectorAll('[role="dialog"] .sheet-item')].map((b) => b.textContent.trim()),
    }))()`,
  );
  await shot('member-more-sheet');
  console.log('member sheet:', JSON.stringify(memberSheet));
  check('member: More sheet opens', memberSheet.open === true);
  check(
    'member: no AI item in More sheet',
    memberSheet.hasAi === false,
    memberSheet.items.join(' | '),
  );
  check(
    'member: theme toggle still in More sheet',
    memberSheet.items.some((t) => /theme/i.test(t)),
  );

  // --- Admin: AI entry still present ---
  await evalJs(
    `(() => { document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click(); return true; })()`,
  );
  await sleep(400);
  await evalJs(
    `(() => { document.querySelector('button[aria-label="Sign out"]').click(); return true; })()`,
  );
  await sleep(500);
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === 'Sign out'); if (b) b.click(); return true; })()`,
  );
  await sleep(2000);
  await login('rafael', 'review123');
  console.log('admin path:', await evalJs('location.pathname'));

  await setWidth(1280);
  const adminCount = await footerAiButtons();
  await shot('admin-sidebar');
  check('admin: AI button still in sidebar footer', adminCount === 1, `${adminCount} nav-item(s)`);

  await setWidth(400);
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('.bottom-nav button')].find((x) => x.textContent.includes('More')); if (b) b.click(); return true; })()`,
  );
  await sleep(600);
  const adminSheet = await evalJs(
    `(() => ({
      hasAi: [...document.querySelectorAll('[role="dialog"] .sheet-item')].some((b) => Boolean(b.querySelector('.lucide-sparkles'))),
      items: [...document.querySelectorAll('[role="dialog"] .sheet-item')].map((b) => b.textContent.trim()),
    }))()`,
  );
  console.log('admin sheet:', JSON.stringify(adminSheet));
  check(
    'admin: AI item still in More sheet',
    adminSheet.hasAi === true,
    adminSheet.items.join(' | '),
  );

  ws.close();
  chrome.kill();
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
