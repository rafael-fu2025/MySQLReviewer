/**
 * One-off: verify the Workspace schema sidebar accordion. Connects, opens the
 * workspace, expands a table, screenshots, then clicks a column and reports
 * whether its identifier was inserted into the SQL editor.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9349;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-acc-'));
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

  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await sleep(3000);
  await evalJs(
    `(() => { const cards = [...document.querySelectorAll('.card')]; for (const c of cards) { const b = [...c.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Connect')); if (b) { b.click(); return true; } } return false; })()`,
  );
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    if ((await evalJs('location.pathname')) === '/workspace') break;
  }
  await sleep(2500);

  // Expand the "customers" table in the sidebar.
  const expanded = await evalJs(`(() => {
    const item = [...document.querySelectorAll('.schema-side .tree-item')].find((el) =>
      el.textContent.includes('customers'),
    );
    if (!item) return null;
    const nameBtn = item.querySelector('button[aria-expanded]');
    if (!nameBtn) return null;
    nameBtn.click();
    return true;
  })()`);
  console.log('expanded customers:', expanded);
  await sleep(1200);
  const debug = await evalJs(
    `(() => {
      const item = [...document.querySelectorAll('.schema-side .tree-item')].find((el) =>
        el.textContent.includes('customers'),
      );
      if (!item) return 'item not found';
      const wrapper = item.parentElement;
      const expandedBox = wrapper.querySelector('div.mb-1');
      return JSON.stringify({
        expandedBoxExists: Boolean(expandedBox),
        boxText: expandedBox ? expandedBox.textContent.slice(0, 300) : null,
        buttonsInBox: expandedBox ? expandedBox.querySelectorAll('button').length : 0,
      });
    })()`,
  );
  console.log('DEBUG:', debug);

  const columnInfo = await evalJs(`(() => {
    const cols = [...document.querySelectorAll('.schema-side .tree-list button')]
      .filter((b) => b.textContent.includes('customerName') || b.textContent.includes('customerNumber'))
      .map((b) => b.textContent.trim().slice(0, 40));
    return JSON.stringify({ columnButtons: cols.slice(0, 4), count: cols.length });
  })()`);
  console.log('columns:', columnInfo);

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evalJs(
    `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`,
  );
  await sleep(300);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(
    path.resolve('.snapshot', 'workspace-accordion.png'),
    Buffer.from(shot.data, 'base64'),
  );

  // Click the CustomerID column and check the editor received it.
  const before = await evalJs(
    `document.querySelector('.cm-content')?.textContent?.slice(0, 200) ?? ''`,
  );
  const clicked = await evalJs(`(() => {
    const col = [...document.querySelectorAll('.schema-side .tree-list button')].find((b) =>
      b.textContent.includes('CustomerID'),
    );
    if (!col) return false;
    col.click();
    return true;
  })()`);
  await sleep(600);
  const after = await evalJs(
    `document.querySelector('.cm-content')?.textContent?.slice(0, 200) ?? ''`,
  );
  console.log(
    JSON.stringify({
      columnClicked: clicked,
      inserted: after.includes('`CustomerID`') && !before.includes('CustomerID'),
      editorNow: after.slice(0, 80),
    }),
  );

  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
