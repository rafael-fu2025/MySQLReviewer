/**
 * One-off: verify interactive controls use the custom portal tooltip rather
 * than native title attributes. Signs in, connects, hovers a schema row, and
 * focuses a topbar icon button.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9388;
const APP = process.env.APP_URL;
const USERNAME = process.env.TOOLTIP_USERNAME;
const PASSWORD = process.env.TOOLTIP_PASSWORD;
const OUT = path.resolve('.snapshot', 'tooltip');

if (!APP || !USERNAME || !PASSWORD) {
  throw new Error('Set APP_URL, TOOLTIP_USERNAME, and TOOLTIP_PASSWORD.');
}

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-tooltip-'));
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
  const page = targets.find((target) => target.type === 'page');
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const handled = pending.get(message.id);
      pending.delete(message.id);
      message.error ? handled.reject(message.error) : handled.resolve(message.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
      ?.value;
  const waitFor = async (expression, timeout = 15000) => {
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
  const mouseToElement = async (selectorExpression) => {
    const point = await evalJs(`(() => {
      const element = ${selectorExpression};
      if (!element) return null;
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    if (!point) throw new Error(`Missing element: ${selectorExpression}`);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      clickCount: 0,
    });
  };
  const tooltipState = () =>
    evalJs(`(() => {
      const tips = [...document.querySelectorAll('.tip')];
      const first = tips[0];
      const style = first ? getComputedStyle(first) : null;
      return {
        count: tips.length,
        text: first?.textContent ?? null,
        role: first?.getAttribute('role') ?? null,
        position: style?.position ?? null,
        background: style?.backgroundColor ?? null,
        color: style?.color ?? null,
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
  if (!(await waitFor("Boolean(document.querySelector('.auth-page'))"))) {
    throw new Error('Login page did not load');
  }
  await type('input[autocomplete="username"]', USERNAME);
  await type('input[type="password"]', PASSWORD);
  await evalJs(`document.querySelector('.auth-card button[type="submit"]').click()`);
  if (!(await waitFor("location.pathname === '/connect'")))
    throw new Error('Did not reach Connect');
  await evalJs(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent.trim().startsWith('Connect'),
    );
    button?.click();
    return Boolean(button);
  })()`);
  if (!(await waitFor("location.pathname === '/workspace'"))) throw new Error('Did not connect');

  const nativeState = await evalJs(`(() => ({
    interactive: [...document.querySelectorAll('button[title], [role="button"][title], a[title]')]
      .map((element) => ({ tag: element.tagName, text: element.textContent.trim().slice(0, 80) })),
    nonData: [...document.querySelectorAll('[title]')]
      .filter((element) => !['TD', 'TH', 'INPUT'].includes(element.tagName))
      .map((element) => ({ tag: element.tagName, text: element.textContent.trim().slice(0, 80) })),
    dataCells: document.querySelectorAll('td[title], th[title]').length,
  }))()`);
  console.log('native titles:', JSON.stringify(nativeState));
  check(
    'interactive controls have no native title',
    nativeState.interactive.length === 0,
    JSON.stringify(nativeState.interactive.slice(0, 3)),
  );
  check(
    'non-data controls have no native title',
    nativeState.nonData.length === 0,
    JSON.stringify(nativeState.nonData.slice(0, 3)),
  );

  const tableSelector = '[aria-expanded]';
  const hasTable = await waitFor(
    `[...document.querySelectorAll(${JSON.stringify(tableSelector)})].some((element) =>
      element.textContent.trim().includes('orders'),
    )`,
  );
  check('schema table row is present', hasTable === true);
  await mouseToElement(
    `[...document.querySelectorAll(${JSON.stringify(tableSelector)})].find((element) =>
      element.textContent.trim().includes('orders'),
    )`,
  );
  await sleep(500);
  const schemaTooltip = await tooltipState();
  console.log('schema tooltip:', JSON.stringify(schemaTooltip));
  check('schema tooltip opens on hover', schemaTooltip.count === 1, `${schemaTooltip.count} tips`);
  check(
    'schema tooltip names the table action',
    /^(Collapse|Expand) orders$/.test(schemaTooltip.text ?? ''),
    schemaTooltip.text ?? 'none',
  );
  check('schema tooltip uses the custom portal role', schemaTooltip.role === 'tooltip');
  check('schema tooltip is fixed and portal-positioned', schemaTooltip.position === 'fixed');
  check(
    'schema tooltip uses the custom dark bubble colors',
    schemaTooltip.background === 'rgb(21, 28, 39)' && schemaTooltip.color === 'rgb(238, 244, 255)',
    `${schemaTooltip.background} / ${schemaTooltip.color}`,
  );
  await shot('schema-row-tooltip');

  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 10,
    y: 10,
    button: 'none',
    clickCount: 0,
  });
  await sleep(300);
  check('schema tooltip closes on leave', (await tooltipState()).count === 0);

  await evalJs(`document.querySelector('button[aria-label="Sign out"]')?.focus()`);
  await sleep(150);
  const signOutTooltip = await tooltipState();
  console.log('sign-out tooltip:', JSON.stringify(signOutTooltip));
  check('focused icon button opens its custom tooltip', signOutTooltip.count === 1);
  check(
    'sign-out tooltip text is correct',
    signOutTooltip.text === 'Sign out',
    signOutTooltip.text ?? 'none',
  );
  check(
    'sign-out tooltip uses the custom dark bubble colors',
    signOutTooltip.background === 'rgb(21, 28, 39)' &&
      signOutTooltip.color === 'rgb(238, 244, 255)',
  );
  await shot('icon-button-tooltip');
  await evalJs('document.activeElement?.blur()');

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
