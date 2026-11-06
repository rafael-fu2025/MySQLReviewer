/**
 * One-off: verify client-side route recovery. Signs in, connects, exercises
 * sidebar navigation, fails a route chunk once (retry must recover), then fails
 * another route persistently (the error boundary must replace a blank page).
 * Also proves missing assets return 404 and index.html is no-store.
 */
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9389;
const APP = process.env.APP_URL;
const USERNAME = process.env.ROUTE_USERNAME;
const PASSWORD = process.env.ROUTE_PASSWORD;
const OUT = path.resolve('.snapshot', 'route-stability');

if (!APP || !USERNAME || !PASSWORD) {
  throw new Error('Set APP_URL, ROUTE_USERNAME, and ROUTE_PASSWORD.');
}

const appUrl = new URL(APP);
if (appUrl.protocol !== 'http:' && appUrl.protocol !== 'https:') {
  throw new Error('APP_URL must use http or https.');
}

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-routes-'));
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
const getJson = async (url) => (await fetch(url)).json();
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function chunkFile(prefix) {
  const match = readdirSync(path.resolve('dist', 'assets')).find(
    (file) => file.startsWith(`${prefix}-`) && file.endsWith('.js'),
  );
  if (!match) throw new Error(`No built chunk found for ${prefix}. Run npm run build first.`);
  return match;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const databaseChunk = chunkFile('DatabasePage');
  const performanceChunk = chunkFile('PerformancePage');
  console.log(`database chunk: ${databaseChunk}`);
  console.log(`performance chunk: ${performanceChunk}`);

  for (let i = 0; i < 60; i += 1) {
    try {
      await getJson(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(250);
    }
  }
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((target) => target.type === 'page');
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  let interceptMode = 'off';
  let interceptedCount = 0;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const handled = pending.get(message.id);
      pending.delete(message.id);
      message.error ? handled.reject(message.error) : handled.resolve(message.result);
      return;
    }
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId } = message.params;
    void (async () => {
      interceptedCount += 1;
      if (interceptMode === 'fail') {
        await send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(
          () => undefined,
        );
        return;
      }
      // Keep the first Database request suspended long enough to prove the
      // app shell remains mounted, then fail it so the retry path runs.
      await sleep(450);
      await send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => undefined);
      if (interceptMode === 'fail-once') {
        interceptMode = 'off';
        await send('Fetch.disable').catch(() => undefined);
      }
    })();
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  const evalJs = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
      ?.value;
  const waitFor = async (expression, timeout = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evalJs(expression)) return true;
      await sleep(150);
    }
    return false;
  };
  const type = (selector, value) =>
    evalJs(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      if (!field) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  const shot = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
    console.log(`      captured ${name}.png`);
  };
  const clickCenter = async (expression) => {
    const point = await evalJs(`(() => {
      const element = ${expression};
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()`);
    if (!point) throw new Error(`Missing click target: ${expression}`);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      clickCount: 0,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
  };
  const clickNav = (label) =>
    clickCenter(
      `[...document.querySelectorAll('.nav a')].find((link) => link.textContent.trim() === ${JSON.stringify(
        label,
      )})`,
    );

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Sign in and connect through the same UI paths a member uses.
  await send('Page.navigate', { url: `${APP}/login` });
  if (!(await waitFor("Boolean(document.querySelector('.auth-page'))"))) {
    throw new Error('Login page did not load');
  }
  await type('input[autocomplete="username"]', USERNAME);
  await type('input[type="password"]', PASSWORD);
  await clickCenter('document.querySelector(\'.auth-card button[type="submit"]\')');
  if (!(await waitFor("location.pathname === '/connect'")))
    throw new Error('Did not reach Connect');
  const connectButtonReady = await waitFor(
    `[...document.querySelectorAll('button')].some((button) =>
      button.textContent.trim().startsWith('Connect'),
    )`,
  );
  if (!connectButtonReady) throw new Error('Connect button did not render');
  await clickCenter(
    `[...document.querySelectorAll('button')].find((button) => button.textContent.trim().startsWith('Connect'))`,
  );
  if (!(await waitFor("location.pathname === '/workspace'", 20000))) {
    throw new Error('Did not reach Workspace');
  }

  // One failed Database chunk request: the shell stays mounted, the retry
  // succeeds, and no blank page or manual reload is needed.
  interceptMode = 'fail-once';
  await send('Fetch.enable', {
    patterns: [{ urlPattern: `*${databaseChunk}*`, requestStage: 'Request' }],
  });
  await clickNav('Database');
  await sleep(150);
  const shellDuringLoad = await evalJs(
    `Boolean(document.querySelector('.app-shell')) && Boolean(document.querySelector('.sidebar'))`,
  );
  check('app shell remains mounted while a route chunk retries', shellDuringLoad === true);
  const databaseRecovered = await waitFor(
    `location.pathname.startsWith('/database') &&
      Boolean(document.querySelector('.app-shell')) &&
      !document.querySelector('.route-error-card') &&
      document.body.innerText.includes('Database') &&
      !document.body.innerText.includes('Loading…')`,
    40000,
  );
  const databaseState = await evalJs(`(() => ({
    path: location.pathname,
    text: document.body.innerText.slice(0, 240),
    hasErrorUi: Boolean(document.querySelector('.route-error-card')),
  }))()`);
  console.log('database state:', JSON.stringify(databaseState));
  check('one-shot chunk failure recovers by retry', databaseRecovered === true);
  await shot('database-recovered');
  interceptMode = 'off';
  await send('Fetch.disable').catch(() => undefined);

  // Normal sidebar transitions after recovery.
  await clickNav('SQL Lab');
  const practiceLoaded = await waitFor(
    `location.pathname === '/practice' && document.body.innerText.includes('SQL Lab')`,
  );
  check('SQL Lab navigation renders after recovery', practiceLoaded === true);
  await clickNav('Workspace');
  const workspaceLoaded = await waitFor(
    `location.pathname === '/workspace' && document.body.innerText.includes('Query 1')`,
  );
  check('Workspace navigation renders after recovery', workspaceLoaded === true);
  await shot('route-sweep-recovered');

  // Persistent chunk failure: one automatic reload is allowed, then the error
  // boundary must replace the formerly blank root.
  interceptMode = 'fail';
  await send('Fetch.enable', {
    patterns: [{ urlPattern: `*${performanceChunk}*`, requestStage: 'Request' }],
  });
  await send('Page.navigate', { url: `${APP}/performance` });
  const errorUiAppeared = await waitFor(
    `Boolean(document.querySelector('.route-error-card')) && document.body.innerText.includes('This page could not load.')`,
    30000,
  );
  check('persistent chunk failure shows the recovery UI', errorUiAppeared === true);
  const rootNotEmpty = await evalJs(
    `Boolean(document.querySelector('#root')) && document.querySelector('#root').children.length > 0`,
  );
  check('persistent failure does not leave a blank root', rootNotEmpty === true);
  await shot('route-error-boundary');
  interceptMode = 'off';
  await send('Fetch.disable').catch(() => undefined);

  // Static-server contracts that prevent stale HTML from masquerading as JS.
  const assetContract = await evalJs(`(async () => {
    const missing = await fetch('/assets/route-stability-missing.js');
    const index = await fetch('/', { method: 'HEAD' });
    return {
      missingStatus: missing.status,
      missingType: missing.headers.get('content-type'),
      indexCache: index.headers.get('cache-control'),
    };
  })()`);
  console.log('static contract:', JSON.stringify(assetContract));
  check(
    'missing hashed assets return a real 404',
    assetContract.missingStatus === 404,
    `${assetContract.missingStatus} ${assetContract.missingType ?? ''}`,
  );
  check(
    'missing assets do not return HTML',
    !(assetContract.missingType ?? '').includes('text/html'),
    assetContract.missingType ?? 'none',
  );
  check(
    'index.html is no-store',
    (assetContract.indexCache ?? '').includes('no-store'),
    assetContract.indexCache ?? 'none',
  );

  console.log(`intercepted chunk requests: ${interceptedCount}`);
  check('chunk interception actually ran', interceptedCount >= 2, `${interceptedCount}`);
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
