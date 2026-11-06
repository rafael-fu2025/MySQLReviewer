/**
 * Probe: does the floating assistant really remember a thread across a reload,
 * and does an unrelated re-render re-save the whole transcript?
 *
 * Two properties are measured, both from outside the app:
 *
 *  A. Context identity. The conversation id is derived from the query tab id,
 *     and the tab id only reaches localStorage when something calls save().
 *     This checks the id is stored before the user edits any SQL.
 *  B. Write amplification. Conversation PUTs are counted while the workspace
 *     re-renders for reasons that have nothing to do with the transcript.
 *
 * Run with the app up: node scripts/assistant-memory-probe.mjs [label]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT ?? 9371);
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';
const LABEL = process.argv[2] ?? 'run';
const OUT = path.resolve('.snapshot', 'assistant-memory');
const QUESTION = 'In one short sentence, which database am I connected to?';

const profile = mkdtempSync(path.join(tmpdir(), 'mylens-memory-'));
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < 80; i += 1) {
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
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  /** Every request the page made, so PUTs can be counted by method. */
  const netLog = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Network.requestWillBeSent') {
      netLog.push({ url: msg.params.request.url, method: msg.params.request.method });
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && process.env.PROBE_DEBUG) {
      const args = (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type);
      console.log('CONSOLE', msg.params.type, '|', args.join(' '));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression) => {
    const out = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text ?? 'evaluate failed');
    return out.result?.value;
  };
  const waitFor = async (label, fn, timeoutMs = 20_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await fn();
      if (value) return value;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const shot = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${LABEL}-${name}.png`), Buffer.from(result.data, 'base64'));
  };

  const setField = (selector, value) =>
    evalJs(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );

  const pathNow = () => evalJs('location.pathname');
  const openPanel = async () => {
    await waitFor('assistant button', () => evalJs(`Boolean(document.querySelector('.ai-fab'))`));
    const already = await evalJs(`Boolean(document.querySelector('.ai-panel'))`);
    if (already) return;
    await evalJs(`(() => { document.querySelector('.ai-fab')?.click(); return true; })()`);
    await waitFor('assistant panel', () => evalJs(`Boolean(document.querySelector('.ai-panel'))`));
  };
  const transcript = () =>
    evalJs(`(() => document.querySelector('.ai-chat-log')?.innerText ?? null)()`);
  const busy = () => evalJs(`Boolean(document.querySelector('[data-testid="composer-stop"]'))`);

  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  /* --- sign in and connect ------------------------------------------- */
  await send('Page.navigate', { url: `${APP}/login` });
  await waitFor('login form', () =>
    evalJs(`Boolean(document.querySelector('input[autocomplete="username"]'))`),
  );
  await setField('input[autocomplete="username"]', 'rafael');
  await setField('input[type="password"]', 'review123');
  await evalJs(
    `(() => { document.querySelector('form button[type="submit"]').click(); return true; })()`,
  );
  await sleep(2500);
  await evalJs(
    `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        b.textContent.trim().startsWith('Connect'),
      );
      if (btn) btn.click();
      return true;
    })()`,
  );
  await waitFor('workspace route', async () => (await pathNow()) === '/workspace', 30_000);
  await sleep(1200);

  /* --- ask one question ---------------------------------------------- */
  await openPanel();
  await waitFor('composer', () =>
    evalJs(`Boolean(document.querySelector('.ai-panel .ai-composer-field'))`),
  );
  await setField('.ai-panel .ai-composer-field', QUESTION);
  await evalJs(
    `(() => { document.querySelector('[data-testid="composer-send"]')?.click(); return true; })()`,
  );
  await waitFor(
    'assistant answer',
    async () => {
      const text = await transcript();
      return typeof text === 'string' && text.trim().length > 40 && !(await busy());
    },
    120_000,
  );
  const asked = await transcript();
  await shot('answered');

  /* --- A. is the context identity on disk yet? ----------------------- */
  const identity = await evalJs(`(() => {
    const raw = localStorage.getItem('mylens.workspace.v1');
    if (!raw) return { stored: false, ids: [] };
    const parsed = JSON.parse(raw);
    return { stored: true, ids: (parsed.tabs ?? []).map((tab) => tab.id) };
  })()`);
  const conversationId = await (async () => {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const hit = netLog.find((entry) => entry.url.includes('/api/ai/conversations/'));
      if (hit) {
        return decodeURIComponent(hit.url.split('/api/ai/conversations/')[1].split('?')[0]);
      }
      await sleep(200);
    }
    return null;
  })();
  const tabId = (conversationId ?? '').replace(/^ctx-/, '');
  check(
    'A. the tab id reaches localStorage before any SQL edit',
    identity.stored === true && identity.ids.includes(tabId),
    `stored=${identity.stored} ids=${identity.ids.length} looking for ${tabId || '(none)'}`,
  );

  /* --- the transcript reached the server ----------------------------- */
  const readConversation = (id) =>
    evalJs(
      "fetch('/api/ai/conversations/" +
        id +
        "').then((r) => (r.ok ? r.json() : { status: r.status }))" +
        '.then((body) => ({ status: body.status ?? 200, turns: (body.data?.turns ?? []).length }))',
    );
  const saved = await (async () => {
    const started = Date.now();
    let last = { status: 0, turns: 0 };
    while (Date.now() - started < 20_000) {
      last = await readConversation(conversationId ?? 'none');
      if (last.status === 200 && last.turns === 2) return last;
      await sleep(300);
    }
    return last;
  })();
  check(
    'B. the turn pair is stored server-side',
    saved.status === 200 && saved.turns === 2,
    `status=${saved.status} turns=${saved.turns}`,
  );

  /* --- B. a reload restores the same thread ------------------------- */
  await send('Page.reload');
  await waitFor('workspace after reload', async () => (await pathNow()) === '/workspace', 30_000);
  await sleep(1500);
  await openPanel();
  await sleep(1500);
  const restored = await transcript();
  if (process.env.PROBE_DEBUG) {
    const diag = await evalJs(`(async () => {
      const raw = localStorage.getItem('mylens.workspace.v1');
      const parsed = raw ? JSON.parse(raw) : {};
      const first = (parsed.tabs ?? [])[0] ?? null;
      const convId = first ? 'ctx-' + first.id : null;
      let conv = null;
      if (convId) {
        const response = await fetch('/api/ai/conversations/' + convId);
        conv = {
          id: convId,
          status: response.status,
          turns: response.ok ? (await response.json()).data.turns.length : 0,
        };
      }
      return {
        path: location.pathname,
        activeId: parsed.activeId ?? null,
        tabIds: (parsed.tabs ?? []).map((tab) => tab.id),
        conv,
        logText: document.querySelector('.ai-chat-log')?.innerText ?? null,
      };
    })()`);
    console.log('DIAG', JSON.stringify(diag, null, 2));
    console.log(
      'CONV REQUESTS',
      JSON.stringify(
        netLog
          .filter((entry) => entry.url.includes('/api/ai/conversations'))
          .map((entry) => `${entry.method} ${entry.url.replace(APP, '')}`),
        null,
        2,
      ),
    );
  }
  check(
    'C. the same thread is on screen after a reload',
    typeof restored === 'string' && restored.trim() === (asked ?? '').trim(),
    `before=${(asked ?? '').length} chars, after=${(restored ?? '').length} chars`,
  );
  await shot('restored');

  /* --- C. does an unrelated re-render re-save? ---------------------- */
  netLog.length = 0;
  await evalJs(`(() => {
    const editor = document.querySelector('.cm-content');
    if (editor) editor.focus();
    return Boolean(editor);
  })()`);
  for (let i = 0; i < 5; i += 1) {
    await send('Input.insertText', { text: 'x' });
    await sleep(120);
  }
  await sleep(1500);
  const puts = netLog.filter(
    (entry) => entry.method === 'PUT' && entry.url.includes('/api/ai/conversations/'),
  );
  check(
    'D. unrelated re-renders do not re-save the transcript',
    puts.length === 0,
    `${puts.length} PUT(s) after 5 editor keystrokes`,
  );

  /* --- cleanup ------------------------------------------------------- */
  const url = "fetch('/api/ai/conversations/" + (conversationId ?? 'none');
  if (conversationId) {
    await evalJs(url + "', { method: 'DELETE' }).then((r) => r.status)");
  }
  const gone = await evalJs(url + "').then((r) => r.status)");
  check('cleanup. the probe conversation is deleted', gone === 404, `status=${gone}`);

  ws.close();
  chrome.kill();

  const failed = results.filter((entry) => !entry.ok);
  console.log(
    failed.length === 0
      ? `ALL ${results.length} CHECKS PASSED (${LABEL})`
      : `${failed.length}/${results.length} CHECK(S) FAILED (${LABEL})`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
