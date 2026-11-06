/**
 * One-off: verify the responsive fixes — sidebar toggle works at every width
 * (first visit below 900px defaults to the rail; expand actually expands),
 * and the topbar title ellipsizes instead of hard-clipping.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9357;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve('.snapshot', 'responsive');

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-resp-'));
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
  const measure = () =>
    evalJs(`(() => {
      const bar = document.querySelector('.topbar');
      const sidebar = document.querySelector('.sidebar');
      const title = document.querySelector('.topbar-title');
      const style = title ? getComputedStyle(title) : null;
      return {
        sidebarW: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
        collapsed: sidebar ? sidebar.classList.contains('sidebar-collapsed') : null,
        barH: bar ? Math.round(bar.getBoundingClientRect().height) : null,
        titleText: title ? title.textContent : null,
        titleClipped: title ? title.scrollWidth > title.clientWidth : null,
        titleEllipsis: style ? style.textOverflow : null,
      };
    })()`);

  await send('Page.enable');
  // First paint below 900px so the fresh-visit rail default is the one under test.
  await setWidth(850);
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
    `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Connect')); if (btn) btn.click(); return true; })()`,
  );
  await sleep(3500);
  console.log('path after connect:', await evalJs('location.pathname'));
  await evalJs(
    `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`,
  );

  // --- First-visit defaults (fresh profile, no toggle pressed yet) ---
  for (const width of [720, 850, 1000, 1400]) {
    await setWidth(width);
    const m = await measure();
    console.log(`w${width}:`, JSON.stringify(m));
    await shot(`w${width}`);
    // The session started at 850px (rail), so the collapsed choice persists
    // at every width; what must hold is that the rendered width matches the
    // state at each width band.
    const expected = m.collapsed ? 76 : width <= 1180 ? 220 : 252;
    check(
      `w${width} sidebar width matches its state (${m.collapsed ? 'rail' : 'full'})`,
      m.sidebarW === expected,
      `got ${m.sidebarW}, want ${expected}`,
    );
    check(`w${width} title never hard-clips`, m.titleEllipsis === 'ellipsis');
    if (width <= 900) {
      check(`w${width} topbar wraps picker to its own row (taller bar)`, m.barH > 62);
    } else {
      check(`w${width} topbar stays single row`, m.barH <= 62);
    }
  }

  // --- Toggle round-trip at 850 (the width class from the user's report) ---
  await setWidth(850);
  const before = await measure();
  const expand = await evalJs(
    `(() => { const b = document.querySelector('button[aria-label="Expand sidebar"]'); if (!b) return false; b.click(); return true; })()`,
  );
  await sleep(400);
  const expanded = await measure();
  await shot('w850-expanded');
  const collapse = await evalJs(
    `(() => { const b = document.querySelector('button[aria-label="Collapse sidebar"]'); if (!b) return false; b.click(); return true; })()`,
  );
  await sleep(400);
  const collapsed = await measure();
  check('expand button found at 850', expand === true);
  check(
    'expand actually expands at 850',
    expanded.sidebarW === 220 && !expanded.collapsed,
    `w ${before.sidebarW} → ${expanded.sidebarW}`,
  );
  check(
    'collapse returns to rail at 850',
    collapsed.sidebarW === 76 && collapsed.collapsed,
    `w ${expanded.sidebarW} → ${collapsed.sidebarW}`,
  );

  // --- Toggle round-trip at 1000 (above the old forced-rail band) ---
  await setWidth(1000);
  const wideBefore = await measure();
  await evalJs(
    `(() => { const b = document.querySelector('button[aria-label="Collapse sidebar"]'); if (b) b.click(); return true; })()`,
  );
  await sleep(400);
  const wideCollapsed = await measure();
  await shot('w1000-collapsed');
  await evalJs(
    `(() => { const b = document.querySelector('button[aria-label="Expand sidebar"]'); if (b) b.click(); return true; })()`,
  );
  await sleep(400);
  const wideRestored = await measure();
  check(
    'collapse works at 1000',
    wideCollapsed.sidebarW === 76 && wideCollapsed.collapsed,
    `w ${wideBefore.sidebarW} → ${wideCollapsed.sidebarW}`,
  );
  check(
    'expand restores at 1000',
    wideRestored.sidebarW === 220 && !wideRestored.collapsed,
    `w ${wideCollapsed.sidebarW} → ${wideRestored.sidebarW}`,
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
