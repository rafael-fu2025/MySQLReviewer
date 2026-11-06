/**
 * One-off: probe the CodeMirror Ctrl+F search panel DOM and computed styles
 * to find out why the app's `.cm-panel.cm-search` rules don't apply.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9343;
const APP = 'http://127.0.0.1:8787';

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-cf-'));
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
  await sleep(2000);
  await evalJs(
    `(() => { const cm = document.querySelector('.cm-content'); if (!cm) return 'no editor'; cm.focus(); return 'focused'; })()`,
  );
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers: 2,
    key: 'f',
    code: 'KeyF',
    windowsVirtualKeyCode: 70,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    key: 'f',
    code: 'KeyF',
    windowsVirtualKeyCode: 70,
  });
  await sleep(800);

  const report = await evalJs(`(function () {
    const panel = document.querySelector('.cm-panel.cm-search');
    if (!panel) {
      const anyPanel = document.querySelector('.cm-panels');
      return JSON.stringify({
        found: false,
        anyPanels: Boolean(anyPanel),
        anyPanelHTML: anyPanel ? anyPanel.outerHTML.slice(0, 400) : null,
      });
    }
    const host = panel.closest('.editor-host');
    const input = panel.querySelector('.cm-textfield') || panel.querySelector('input');
    const btn = panel.querySelector('.cm-button') || panel.querySelector('button:not([name=close])');
    const cs = input ? getComputedStyle(input) : null;
    const cb = btn ? getComputedStyle(btn) : null;
    const chain = [];
    let el = panel;
    for (let i = 0; i < 6 && el; i += 1) {
      chain.push(el.className.toString().slice(0, 70));
      el = el.parentElement;
    }
    return JSON.stringify({
      found: true,
      inEditorHost: Boolean(host),
      parentChain: chain,
      inputStyles: cs
        ? { bg: cs.backgroundColor, border: cs.borderColor, font: cs.fontSize, radius: cs.borderRadius }
        : null,
      btnStyles: cb
        ? { bg: cb.backgroundColor, color: cb.color, font: cb.fontSize, bgImage: cb.backgroundImage.slice(0, 50) }
        : null,
      panelHTML: panel.outerHTML.slice(0, 500),
    });
  })()`);
  console.log(report);

  // Capture the open panel for visual verification.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 620,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(600);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.resolve('.snapshot', 'search-panel.png'), Buffer.from(shot.data, 'base64'));
  console.log('captured .snapshot/search-panel.png');

  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
