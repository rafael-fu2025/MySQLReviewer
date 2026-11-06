/**
 * One-off: verify the sign-out confirmation — the button opens a dialog,
 * Cancel keeps the session, Confirm signs out and lands on /login.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9363;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve('.snapshot', 'signout');

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-out-'));
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
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
  };
  const dialogState = () =>
    evalJs(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const rect = dialog?.getBoundingClientRect();
      return {
        path: location.pathname,
        dialogOpen: Boolean(dialog),
        title: dialog?.querySelector('.modal-title')?.textContent ?? null,
        message: dialog?.textContent?.match(/Sign out of MyLens[^?]*/)?.[0] ?? null,
        hasCancel: [...(dialog?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === 'Cancel'),
        confirmLabel: [...(dialog?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()).find((t) => t === 'Sign out') ?? null,
        centerOffset: rect
          ? {
              x: Math.round(rect.left + rect.width / 2 - window.innerWidth / 2),
              y: Math.round(rect.top + rect.height / 2 - window.innerHeight / 2),
            }
          : null,
      };
    })()`);

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
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
  await evalJs(
    `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Connect')); if (btn) btn.click(); return true; })()`,
  );
  await sleep(3500);
  console.log('path after connect:', await evalJs('location.pathname'));

  // 0. The standalone Connect screen has its own account header and sign-out.
  await send('Page.navigate', { url: `${APP}/connect` });
  await sleep(1500);
  const connectHeader = await evalJs(`(() => {
    const header = document.querySelector('header');
    const signOut = [...(header?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent.trim() === 'Sign out',
    );
    const session = header?.querySelector('.connect-session');
    const headerRect = header?.getBoundingClientRect();
    const sessionRect = session?.getBoundingClientRect();
    const signOutRect = signOut?.getBoundingClientRect();
    const sessionStyle = session ? getComputedStyle(session) : null;
    return {
      path: location.pathname,
      hasHeader: Boolean(header),
      sticky: header ? getComputedStyle(header).position === 'sticky' : false,
      account: header?.querySelector('.connect-account')?.textContent ?? null,
      hasSignOut: Boolean(signOut),
      width: headerRect?.width ?? 0,
      headerHeight: headerRect?.height ?? 0,
      sessionHeight: sessionRect?.height ?? 0,
      signOutHeight: signOutRect?.height ?? 0,
      sessionRadius: sessionStyle?.borderRadius ?? null,
    };
  })()`);
  console.log('connect header:', JSON.stringify(connectHeader));
  await shot('connect-header');
  check('Connect screen renders the account header', connectHeader.hasHeader === true);
  check('Connect header stays docked while page scrolls', connectHeader.sticky === true);
  check('Connect header names the signed-in account', /sherina/i.test(connectHeader.account ?? ''));
  check('Connect header has a sign-out button', connectHeader.hasSignOut === true);
  check(
    'Connect header is compact',
    connectHeader.headerHeight >= 48 && connectHeader.headerHeight <= 56,
    `${connectHeader.headerHeight}px`,
  );
  check(
    'identity and sign-out share one 32px control',
    Math.round(connectHeader.sessionHeight) === 32 &&
      Math.round(connectHeader.signOutHeight) >= 29 &&
      Math.round(connectHeader.signOutHeight) <= 32,
    `${connectHeader.sessionHeight}px / ${connectHeader.signOutHeight}px`,
  );
  check(
    'session control uses the shared 8px shape',
    connectHeader.sessionRadius === '8px',
    connectHeader.sessionRadius ?? 'none',
  );

  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
  const mobileHeader = await evalJs(`(() => {
    const header = document.querySelector('.connect-header');
    const session = document.querySelector('.connect-session');
    return {
      headerHeight: header?.getBoundingClientRect().height ?? 0,
      sessionHeight: session?.getBoundingClientRect().height ?? 0,
      noHScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    };
  })()`);
  await shot('connect-header-mobile');
  console.log('mobile connect header:', JSON.stringify(mobileHeader));
  check(
    'mobile header stays compact',
    mobileHeader.headerHeight >= 48 && mobileHeader.headerHeight <= 56,
    `${mobileHeader.headerHeight}px`,
  );
  check('mobile header has no horizontal overflow', mobileHeader.noHScroll === true);
  await setWidth(1280);
  await sleep(300);

  await evalJs(
    `(() => { [...document.querySelectorAll('header button')].find((button) => button.textContent.trim() === 'Sign out')?.click(); return true; })()`,
  );
  await sleep(600);
  const connectDialog = await dialogState();
  check(
    'Connect sign-out dialog is centred',
    connectDialog.dialogOpen === true &&
      Math.abs(connectDialog.centerOffset.x) <= 1 &&
      Math.abs(connectDialog.centerOffset.y) <= 1,
    JSON.stringify(connectDialog.centerOffset),
  );
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === 'Cancel'); if (b) b.click(); return true; })()`,
  );
  await sleep(600);
  await send('Page.navigate', { url: `${APP}/workspace` });
  await sleep(1200);

  // 1. Clicking sign-out opens the dialog, session still active.
  await evalJs(
    `(() => { document.querySelector('button[aria-label="Sign out"]').click(); return true; })()`,
  );
  await sleep(600);
  const d1 = await dialogState();
  console.log('after click:', JSON.stringify(d1));
  await shot('signout-dialog');
  check('dialog opens', d1.dialogOpen === true);
  check(
    'dialog is centred in the viewport',
    Math.abs(d1.centerOffset.x) <= 1 && Math.abs(d1.centerOffset.y) <= 1,
    JSON.stringify(d1.centerOffset),
  );
  check('dialog title', d1.title === 'Sign out?', d1.title ?? 'none');
  check(
    'message names the user',
    /Sign out of MyLens as sherina/.test(d1.message ?? ''),
    d1.message ?? 'none',
  );
  check('confirm button labeled Sign out', d1.confirmLabel === 'Sign out');
  check(
    'still signed in while dialog open',
    d1.path.startsWith('/workspace') || d1.path.startsWith('/database'),
  );

  // 2. Cancel keeps the session and closes the dialog.
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === 'Cancel'); if (b) b.click(); return true; })()`,
  );
  await sleep(600);
  const d2 = await dialogState();
  check('cancel closes dialog', d2.dialogOpen === false);
  check('cancel keeps session', !d2.path.startsWith('/login'), d2.path);

  // 3. Confirm signs out and lands on /login.
  await evalJs(
    `(() => { document.querySelector('button[aria-label="Sign out"]').click(); return true; })()`,
  );
  await sleep(600);
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === 'Sign out'); if (b) b.click(); return true; })()`,
  );
  await sleep(2000);
  const d3 = await dialogState();
  await shot('after-signout');
  check('confirm lands on /login', d3.path === '/login', d3.path);
  check('dialog gone after sign-out', d3.dialogOpen === false);

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
