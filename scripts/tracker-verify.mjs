/**
 * One-off: verify the question tracker move — compact strip above the
 * schema tables panel, strictly square number placeholders, toggle works.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9367;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve('.snapshot', 'tracker');

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-trk-'));
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
    await sleep(600);
  };
  const trackerInfo = () =>
    evalJs(`(() => {
      // Two .practice-nav nodes can exist (nested for lg+, standalone below);
      // the rendered one is whichever has a box.
      const nav = [...document.querySelectorAll('.practice-nav')].find((n) => n.getBoundingClientRect().width > 0) ?? null;
      if (!nav) return { present: false };
      const boxes = [...nav.querySelectorAll('.practice-nav-box')];
      const rects = boxes.map((b) => { const r = b.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; });
      // The tables panel is the sticky wrapper in the right column.
      const schema = document.querySelector('.practice-stage .sticky');
      const navRect = nav.getBoundingClientRect();
      const schemaRect = schema?.getBoundingClientRect();
      return {
        present: true,
        count: boxes.length,
        rects,
        allSquare: rects.every((r) => Math.abs(r.w - r.h) <= 0.6),
        maxSize: Math.max(...rects.map((r) => r.w)),
        navBottom: Math.round(navRect.bottom),
        navRight: Math.round(navRect.right),
        schemaTop: schemaRect && schemaRect.height > 0 ? Math.round(schemaRect.top) : null,
        schemaRight: schemaRect && schemaRect.height > 0 ? Math.round(schemaRect.right) : null,
        aboveSchema: schemaRect && schemaRect.height > 0 ? navRect.bottom <= schemaRect.top : null,
        sameColumn: schemaRect && schemaRect.height > 0 ? Math.abs(schemaRect.right - navRect.right) <= 2 : null,
        visible: navRect.width > 0 && navRect.height > 0,
      };
    })()`);

  await send('Page.enable');
  await setWidth(1440);
  await send('Page.navigate', { url: `${APP}/login` });
  await sleep(2500);
  await type('input[autocomplete="username"]', 'rafael');
  await type('input[type="password"]', 'review123');
  await evalJs(
    `(() => { document.querySelector('form button[type="submit"]').click(); return true; })()`,
  );
  await sleep(2500);
  // Sets are profile-scoped and un-owned legacy sets are admin-only, so
  // connect the Rafael profile (where the northwind sets live).
  await evalJs(
    `(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Rafael'));
      const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Connect'));
      if (btn) btn.click();
      return Boolean(btn);
    })()`,
  );
  await sleep(3500);
  await send('Page.navigate', { url: `${APP}/practice` });
  await sleep(4000);
  const opened = await evalJs(
    `(() => { const btn = [...document.querySelectorAll('button')].find((b) => /\\d+ challenges/.test(b.textContent)); if (btn) { btn.click(); return btn.textContent.trim().slice(0, 40); } return null; })()`,
  );
  console.log('opened set:', opened);
  await sleep(4500);

  // --- Desktop: strip above the tables panel, small squares ---
  const d = await trackerInfo();
  console.log('1440px:', JSON.stringify(d));
  await shot('tracker-1440');
  check('tracker present with all questions', d.present && d.count >= 10, `${d.count} boxes`);
  check('every placeholder is square (±0.6px)', d.allSquare === true);
  check('placeholders are compact (≤30px)', d.maxSize <= 30, `largest ${d.maxSize}px`);
  check(
    'tracker sits above the tables panel',
    d.aboveSchema === true,
    `nav bottom ${d.navBottom} vs schema top ${d.schemaTop}`,
  );
  check('tracker shares the schema column', d.sameColumn === true);

  // --- Interaction: squares jump to questions, flag marks the square ---
  await evalJs(
    `(() => { document.querySelectorAll('.practice-nav-box')[2]?.click(); return true; })()`,
  );
  await sleep(600);
  const activeMoved = await evalJs(
    `(() => { const active = document.querySelector('.practice-nav-box.active'); return active ? active.textContent.trim() : null; })()`,
  );
  check('clicking square 3 makes it active', activeMoved === '3', `active: ${activeMoved}`);
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('.practice-nav-head button')].find((x) => /flag/i.test(x.getAttribute('aria-label') ?? '')); if (b) b.click(); return true; })()`,
  );
  await sleep(500);
  const flagged = await evalJs(
    `(() => Boolean(document.querySelector('.practice-nav-box.active .practice-nav-flag')))()`,
  );
  check('flag button flags the active square', flagged === true);

  // --- Toolbar toggle hides the strip, tables stay ---
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Hide challenges'); if (b) b.click(); return true; })()`,
  );
  await sleep(600);
  const hidden = await trackerInfo();
  const schemaStill = await evalJs(
    `(() => { const el = document.querySelector('.practice-stage .sticky'); return Boolean(el && el.getBoundingClientRect().height > 0); })()`,
  );
  check('Hide challenges removes the strip', hidden.present === false);
  check('tables panel stays without the strip', schemaStill === true);
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Challenges'); if (b) b.click(); return true; })()`,
  );
  await sleep(600);

  // --- Below lg: standalone strip flows under the challenge, still square ---
  await setWidth(900);
  const m = await trackerInfo();
  console.log('900px:', JSON.stringify(m));
  await shot('tracker-900');
  check('tracker visible below lg', m.present === true && m.visible === true);
  check('squares stay square below lg', m.allSquare === true);
  const editorTop = await evalJs(
    `(() => { const ed = document.querySelector('.cm-editor'); return ed ? Math.round(ed.getBoundingClientRect().top) : null; })()`,
  );
  check('challenge content stays above the strip', editorTop !== null && m.navBottom > editorTop);

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
