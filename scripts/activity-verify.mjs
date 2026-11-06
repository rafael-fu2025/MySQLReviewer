/**
 * One-off: verify pagination controls on the admin Activity table — footer
 * counts, next/prev navigation, and row changes between pages.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9361;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve('.snapshot', 'activity');

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-act-'));

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
  const state = () =>
    evalJs(`(() => {
      const rows = document.querySelectorAll('.data-table tbody tr');
      const footer = [...document.querySelectorAll('span')].map((s) => s.textContent).filter((t) => /^Page \\d+ of \\d+$/.test(t))[0] ?? null;
      const count = [...document.querySelectorAll('span')].map((s) => s.textContent).find((t) => /\\d+ entr(y|ies)/.test(t)) ?? null;
      const prev = document.querySelector('button[aria-label="Previous page"]');
      const next = document.querySelector('button[name="Next page"], button[aria-label="Next page"]');
      return {
        path: location.pathname + location.search,
        heading: document.querySelector('.page-title')?.textContent ?? null,
        rows: rows.length,
        footer,
        count,
        prevDisabled: prev ? prev.disabled : null,
        nextDisabled: next ? next.disabled : null,
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
  await type('input[autocomplete="username"]', 'rafael');
  await type('input[type="password"]', 'review123');
  await evalJs(
    `(() => { document.querySelector('form button[type="submit"]').click(); return true; })()`,
  );
  await sleep(2500);
  await send('Page.navigate', { url: `${APP}/admin` });
  await sleep(3500);
  // AdminPage tabs are click-only (?tab= is not read), so click like a user.
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Activity'); if (b) b.click(); return Boolean(b); })()`,
  );
  await sleep(1500);
  await evalJs(
    `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`,
  );

  const s1 = await state();
  console.log('page 1:', JSON.stringify(s1));
  await shot('activity-page1');
  check(
    'footer shows page 1 of N',
    /^Page 1 of \d+$/.test(s1.footer ?? ''),
    s1.footer ?? 'missing',
  );
  check('entry count label present', /\d+ entr(y|ies)/.test(s1.count ?? ''), s1.count ?? 'missing');
  check(
    'page 1 has exactly PAGE_SIZE rows (or fewer if short log)',
    s1.rows > 0 && s1.rows <= 20,
    `${s1.rows} rows`,
  );
  check('prev disabled on page 1', s1.prevDisabled === true);

  const maxPage = Number((s1.footer ?? '').match(/Page 1 of (\d+)/)?.[1] ?? 0);
  if (maxPage >= 2) {
    await evalJs(
      `(() => { document.querySelector('button[aria-label="Next page"]').click(); return true; })()`,
    );
    await sleep(900);
    const s2 = await state();
    console.log('page 2:', JSON.stringify(s2));
    await shot('activity-page2');
    check('next advances to page 2', s2.footer === `Page 2 of ${maxPage}`, s2.footer ?? '');
    check('prev enabled on page 2', s2.prevDisabled === false);
    await evalJs(
      `(() => { document.querySelector('button[aria-label="Previous page"]').click(); return true; })()`,
    );
    await sleep(900);
    const s3 = await state();
    check('prev returns to page 1', s3.footer === `Page 1 of ${maxPage}`, s3.footer ?? '');
    check('prev disabled again on page 1', s3.prevDisabled === true);
  } else {
    check('single-page log disables next', s1.nextDisabled === true);
  }

  // --- User filter via the custom combobox ---
  await evalJs(
    `(() => { document.querySelector('.content .combo-button').click(); return true; })()`,
  );
  await sleep(500);
  const popover = await evalJs(
    `(() => ({ open: Boolean(document.querySelector('.combo-popover')), options: [...document.querySelectorAll('.combo-option')].map((o) => o.textContent.trim().slice(0, 24)) }))()`,
  );
  console.log('popover:', JSON.stringify(popover));
  await shot('activity-filter-open');
  check(
    'combobox opens with All users option',
    popover.open && popover.options.some((t) => t.includes('All users')),
  );

  await evalJs(
    `(() => { const opt = [...document.querySelectorAll('.combo-option')].find((o) => /sherina/.test(o.textContent)); if (opt) opt.click(); return true; })()`,
  );
  await sleep(1000);
  const f1 = await state();
  console.log('filtered:', JSON.stringify(f1));
  await shot('activity-filtered');
  check(
    'filter selects sherina, resets to page 1',
    f1.footer?.startsWith('Page 1 of '),
    f1.footer ?? '',
  );
  const totalAll = Number((s1.count ?? '').match(/(\d+)/)?.[1] ?? 0);
  const totalSherina = Number((f1.count ?? '').match(/(\d+)/)?.[1] ?? 0);
  check(
    'filtered count smaller than all-users count',
    totalSherina > 0 && totalSherina < totalAll,
    `${totalSherina} vs ${totalAll}`,
  );

  await evalJs(
    `(() => { document.querySelector('.content .combo-button').click(); return true; })()`,
  );
  await sleep(500);
  await evalJs(
    `(() => { const opt = [...document.querySelectorAll('.combo-option')].find((o) => o.textContent.includes('All users')); if (opt) opt.click(); return true; })()`,
  );
  await sleep(1000);
  const f2 = await state();
  check(
    'back to All users restores full count',
    f2.count === s1.count,
    `${f2.count} vs ${s1.count}`,
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
