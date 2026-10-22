/**
 * Measures the topbar harness at exact viewport widths using the Chrome
 * DevTools Protocol. Chrome's CLI has a 500px minimum window width, so
 * device metrics have to be overridden to test phone widths.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..', '..');

// The built CSS filename is content-hashed, so copy it to a stable name the
// harness can link against.
const assetsDir = path.join(projectRoot, 'dist', 'assets');
const cssFile = readdirSync(assetsDir).find((f) => f.endsWith('.css'));
if (!cssFile) throw new Error('no built CSS found — run npm run build first');
copyFileSync(path.join(assetsDir, cssFile), path.join(scriptDir, 'app.css'));

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HARNESS = 'file:///' + path.join(scriptDir, 'harness.html').replace(/\\/g, '/');
const PORT = 9333;
const WIDTHS = [360, 390, 430, 640, 768, 1024, 1440];
const HEIGHT = 844;

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-cdp-'));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function waitForChrome() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
      if (version) return version;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never became ready');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

async function main() {
  await waitForChrome();
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = await connect(page.webSocketDebuggerUrl);
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

  await send('Page.enable');
  await send('Runtime.enable');

  const rows = [];
  for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    await send('Page.navigate', { url: HARNESS });
    await sleep(900);
    const result = await send('Runtime.evaluate', {
      expression:
        "document.getElementById('report') ? document.getElementById('report').textContent : 'NO_REPORT'",
      returnByValue: true,
    });
    const text = result.result?.value ?? 'NO_REPORT';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(`width ${width}: unparseable -> ${String(text).slice(0, 200)}`);
      continue;
    }
    rows.push({ width, parsed });
  }

  console.log(
    'width | variant | main  | topbarScroll | clipped | overflow | title | crush | clipped control',
  );
  console.log('------+---------+-------+--------------+---------+----------+-------+------');
  for (const { width, parsed } of rows) {
    for (const r of parsed.flat()) {
      if (r.detailWidth !== undefined) {
        console.log(
          `${String(width).padEnd(5)} | ${r.shell.padEnd(7)} | aside=${String(r.asideWidth).padEnd(6)} detail=${String(r.detailWidth).padEnd(6)} crush=${r.detailCrush}`,
        );
        continue;
      }
      const flag = r.clippedChildren > 0 ? `CLIP(${r.clippedChildren})` : 'ok';
      console.log(
        `${String(width).padEnd(5)} | ${r.shell.padEnd(7)} | ${String(r.mainWidth).padEnd(5)} | ${String(r.topbarScrollWidth).padEnd(12)} | ${flag.padEnd(7)} | ${String(r.overflowPx).padStart(4)}px    | ${String(r.titleWidth).padEnd(5)} | ${String(r.titleCrush).padEnd(4)} | ${(r.clippedNames || []).join(',')}`,
      );
    }
  }

  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
