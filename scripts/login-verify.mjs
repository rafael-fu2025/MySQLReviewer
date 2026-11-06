/**
 * One-off: verify the redesigned login page — split layout at lg+, compact
 * centered form below, both themes, contrast ratios, and the auth flow.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9369;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve('.snapshot', 'login');

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-auth-'));
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
  const setViewport = async (width, height = 900) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);
  };
  const navigateToLogin = async () => {
    await send('Page.navigate', { url: `${APP}/login` });
    for (let i = 0; i < 80; i += 1) {
      if (await evalJs(`Boolean(document.querySelector('.auth-page'))`)) return;
      await sleep(100);
    }
    throw new Error('Login page did not load');
  };

  // Resolve the actual panel colors rather than assuming a translucent card.
  const contrast = (el) =>
    evalJs(`(() => {
      const lum = ([r, g, b]) => {
        const f = (v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const rgb = (value) => value.match(/[\\d.]+/g)?.slice(0, 3).map(Number);
      const target = document.querySelector(${JSON.stringify(el)});
      if (!target) return null;
      const fg = rgb(getComputedStyle(target).color);
      const bg = rgb(getComputedStyle(document.querySelector('.auth-main')).backgroundColor);
      if (!fg || !bg) return null;
      const l1 = lum(fg);
      const l2 = lum(bg);
      return +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
    })()`);

  const pageState = () =>
    evalJs(`(() => {
      const observatory = document.querySelector('.query-observatory');
      const panel = document.querySelector('.auth-main')?.getBoundingClientRect();
      const submit = document.querySelector('.auth-submit')?.getBoundingClientRect();
      const labels = [...document.querySelectorAll('.auth-card .field-label')];
      return {
        path: location.pathname,
        observatoryHidden: observatory?.getAttribute('aria-hidden') === 'true',
        orbitCount: document.querySelectorAll('.observatory-orbits .orbit').length,
        chipCount: document.querySelectorAll('.observatory-chip').length,
        h1: document.querySelector('h1')?.textContent ?? null,
        labels: labels.map((label) => label.textContent),
        inputsCorrectlyLabelled: labels.every((label) => {
          if (label.htmlFor) return document.getElementById(label.htmlFor) !== null;
          const field = label.closest('label');
          return field?.querySelectorAll('input').length === 1;
        }),
        splitLayout: panel ? panel.left > window.innerWidth * 0.45 && panel.width < window.innerWidth * 0.55 : false,
        submitInBounds: submit ? submit.left >= panel.left && submit.right <= panel.right : false,
        noHScroll: document.documentElement.scrollWidth <= window.innerWidth,
      };
    })()`);

  await send('Page.enable');
  await setViewport(1440);
  await navigateToLogin();
  // Headless Chrome reports prefers-color-scheme: light, so the system
  // default renders light here. Set each theme explicitly.
  await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true; })()`);
  await sleep(300);

  // --- Desktop, dark ---
  const d = await pageState();
  console.log('1440 dark:', JSON.stringify(d));
  await shot('login-dark-1440');
  check('orbital illustration is aria-hidden', d.observatoryHidden === true);
  check('four orbital rings and three labelled nodes', d.orbitCount === 4 && d.chipCount === 3);
  check('desktop uses the editorial split layout', d.splitLayout === true);
  check('form heading is an h1', d.h1 === 'Welcome back.');
  check(
    'username and password use clear labels',
    d.labels.includes('Username') && d.labels.includes('Password'),
    d.labels.join(' | '),
  );
  check('labels correctly own their inputs', d.inputsCorrectlyLabelled === true);
  check('submit action stays inside the panel', d.submitInBounds === true);
  check('no horizontal scroll at 1440', d.noHScroll === true);
  const ratios = {
    h1: await contrast('.auth-heading h1'),
    sub: await contrast('.auth-heading p'),
    labels: await contrast('.auth-card .field-label'),
    note: await contrast('.auth-form-note'),
  };
  console.log('dark contrast:', JSON.stringify(ratios));
  check('dark: heading ≥ 4.5:1', ratios.h1 >= 4.5, `${ratios.h1}`);
  check('dark: sub copy ≥ 4.5:1', ratios.sub >= 4.5, `${ratios.sub}`);
  check('dark: field labels ≥ 4.5:1', ratios.labels >= 4.5, `${ratios.labels}`);
  check('dark: supporting copy ≥ 4.5:1', ratios.note >= 4.5, `${ratios.note}`);

  // --- The observatory moves, without changing form content ---
  const drift1 = await evalJs(
    `getComputedStyle(document.querySelector('.observatory-rings')).transform`,
  );
  await sleep(1400);
  const drift2 = await evalJs(
    `getComputedStyle(document.querySelector('.observatory-rings')).transform`,
  );
  check('orbital rings drift gently', drift1 !== drift2, `${drift1} → ${drift2}`);

  await type('input[type="password"]', 'correct-horse');
  await evalJs(`document.querySelector('.auth-password-toggle').click()`);
  const passwordVisible = await evalJs(
    `document.querySelector('input[autocomplete="current-password"]')?.type === 'text'`,
  );
  await evalJs(`document.querySelector('.auth-password-toggle').click()`);
  const passwordHidden = await evalJs(
    `document.querySelector('input[autocomplete="current-password"]')?.type === 'password'`,
  );
  check('password can be shown and hidden', passwordVisible === true && passwordHidden === true);

  // --- Light theme (tokens flip via data-theme, no reload needed) ---
  await evalJs(`(() => { document.documentElement.dataset.theme = 'light'; return true; })()`);
  await sleep(300);
  await shot('login-light-1440');
  const lr = {
    h1: await contrast('.auth-heading h1'),
    sub: await contrast('.auth-heading p'),
    labels: await contrast('.auth-card .field-label'),
    note: await contrast('.auth-form-note'),
  };
  console.log('light contrast:', JSON.stringify(lr));
  check('light: heading ≥ 4.5:1', lr.h1 >= 4.5, `${lr.h1}`);
  check('light: sub copy ≥ 4.5:1', lr.sub >= 4.5, `${lr.sub}`);
  check('light: field labels ≥ 4.5:1', lr.labels >= 4.5, `${lr.labels}`);
  check('light: supporting copy ≥ 4.5:1', lr.note >= 4.5, `${lr.note}`);
  await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true; })()`);

  // --- Breakpoints ---
  await setViewport(375);
  const b375 = await pageState();
  await shot('login-375');
  check('phone stacks the editorial scene and form', b375.splitLayout === false);
  check('no horizontal scroll at 375', b375.noHScroll === true);
  check('phone keeps a usable submit action', b375.submitInBounds === true);
  await setViewport(375, 667);
  await sleep(250);
  const shortPhone = await evalJs(
    `(() => {
      const page = document.querySelector('.auth-page');
      const before = page.scrollTop;
      page.scrollTop = page.scrollHeight;
      return {
        before,
        after: page.scrollTop,
        height: page.scrollHeight,
        viewport: page.clientHeight,
        bodyHeight: document.body.scrollHeight,
        rootHeight: document.documentElement.scrollHeight,
        scrollable: getComputedStyle(page).overflowY,
      };
    })()`,
  );
  console.log('short phone scroll:', JSON.stringify(shortPhone));
  check('short phones can scroll to every form control', shortPhone.after > 0);
  await evalJs(`document.querySelector('.auth-page').scrollTop = 0`);
  await setViewport(1440);

  // --- Reduced motion: all decorative movement is disabled ---
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await navigateToLogin();
  await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true; })()`);
  const r1 = await evalJs(
    `getComputedStyle(document.querySelector('.observatory-rings')).animationName`,
  );
  const r2 = await evalJs(
    `getComputedStyle(document.querySelector('.observatory-chip')).animationName`,
  );
  check(
    'reduced motion disables the decorative animations',
    r1 === 'none' && r2 === 'none',
    `${r1} | ${r2}`,
  );
  await send('Emulation.setEmulatedMedia', { features: [] });
  await navigateToLogin();

  // --- Auth flow: error state, then a real sign-in ---
  await type('input[autocomplete="username"]', 'sherina');
  await type('input[type="password"]', 'wrong-password');
  await evalJs(
    `(() => { document.querySelector('.auth-card button[type="submit"]').click(); return true; })()`,
  );
  await sleep(1200);
  const errShown = await evalJs(
    `(() => ({ text: document.querySelector('.callout.danger')?.textContent ?? null }))()`,
  );
  await shot('login-error');
  check(
    'wrong password shows the error callout',
    /wrong/i.test(errShown.text ?? ''),
    errShown.text ?? 'none',
  );

  await type('input[type="password"]', 'member123');
  await evalJs(
    `(() => { document.querySelector('.auth-card button[type="submit"]').click(); return true; })()`,
  );
  await sleep(2500);
  const landed = await evalJs('location.pathname');
  check('correct sign-in leaves the login page', landed !== '/login', landed);

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
