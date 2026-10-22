/**
 * Compares two PNG files pixel by pixel using a headless browser canvas.
 * Usage: node scripts/ui-layout/pixel-diff.mjs <a.png> <b.png>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) throw new Error('usage: pixel-diff.mjs <a.png> <b.png>');

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-diff-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function waitForChrome() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
      if (v) return v;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('DevTools endpoint never became ready');
}

async function main() {
  await waitForChrome();
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

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

  await send('Runtime.enable');
  const asData = `data:image/png;base64,${readFileSync(aPath).toString('base64')}`;
  const bsData = `data:image/png;base64,${readFileSync(bPath).toString('base64')}`;
  const expression = `
    (async () => {
      const load = (src) => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
      });
      const a = await load(${JSON.stringify(asData)});
      const b = await load(${JSON.stringify(bsData)});
      if (a.width !== b.width || a.height !== b.height) {
        return JSON.stringify({ error: 'size mismatch', a: [a.width, a.height], b: [b.width, b.height] });
      }
      const ca = document.createElement('canvas');
      ca.width = a.width; ca.height = a.height;
      const ctx = ca.getContext('2d');
      ctx.drawImage(a, 0, 0);
      const da = ctx.getImageData(0, 0, a.width, a.height).data;
      ctx.clearRect(0, 0, a.width, a.height);
      ctx.drawImage(b, 0, 0);
      const db = ctx.getImageData(0, 0, a.width, a.height).data;
      let diff = 0, maxDelta = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(
          Math.abs(da[i] - db[i]),
          Math.abs(da[i+1] - db[i+1]),
          Math.abs(da[i+2] - db[i+2]),
        );
        if (d > 0) {
          diff++;
          if (d > maxDelta) maxDelta = d;
          const p = i / 4;
          const x = p % a.width, y = (p / a.width) | 0;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return JSON.stringify({
        width: a.width, height: a.height,
        totalPixels: a.width * a.height,
        differingPixels: diff,
        percent: ((diff / (a.width * a.height)) * 100).toFixed(4),
        maxChannelDelta: maxDelta,
        bbox: diff ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
      });
    })()
  `;

  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(result.result?.value ?? JSON.stringify(result));

  ws.close();
  chrome.kill();
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
