import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  APP_NAME,
  APP_VERSION,
  BODY_LIMIT,
  CLIENT_DIST,
  DATA_DIR,
  DEV_ORIGINS,
  HOST,
  PORT,
  detectXampp,
  ensureDataDirs,
} from './config';
import { AppError, mapDbError } from './errors';
import { isBootstrapRequestAllowed } from './bootstrap-origin';
import { shutdownPools } from './db/manager';
import { listProfiles } from './store/profiles';
import { listProviders } from './store/providers';
import { getSettings } from './store/settings';
import { connectionsRouter } from './routes/connections';
import { explorerRouter } from './routes/explorer';
import { queryRouter } from './routes/query';
import { metricsRouter } from './routes/metrics';
import { securityRouter } from './routes/security';
import { reviewRouter } from './routes/review';
import { aiRouter } from './routes/ai';
import { auditRouter } from './routes/audit';
import { reportsRouter } from './routes/reports';
import { historyRouter } from './routes/history';
import { snippetsRouter } from './routes/snippets';
import { practiceRouter } from './routes/practice';
import { settingsRouter } from './routes/settings';
import type { BootstrapInfo } from '../shared/types';

ensureDataDirs();

const API_TOKEN = crypto.randomBytes(32).toString('hex');
const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: BODY_LIMIT }));

function hostnameOf(req: Request): string {
  const host = (req.headers.host ?? '').toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  return host.split(':')[0];
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  const host = hostnameOf(req);
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (HOST !== '0.0.0.0' && HOST !== '::') allowed.add(HOST.toLowerCase());
  if (!allowed.has(host)) {
    res.status(403).json({
      error: {
        code: 'HOST_NOT_ALLOWED',
        message: 'This app only accepts requests addressed to localhost.',
      },
    });
    return;
  }

  const origin = req.headers.origin;
  if (origin) {
    const expected = `${req.protocol}://${req.headers.host}`;
    if (!DEV_ORIGINS.has(origin) && origin !== expected) {
      res.status(403).json({
        error: {
          code: 'ORIGIN_NOT_ALLOWED',
          message: 'Cross-origin requests are not allowed.',
        },
      });
      return;
    }
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { ok: true, app: APP_NAME, version: APP_VERSION } });
});

app.get('/api/bootstrap', async (req, res, next) => {
  const expectedOrigin = `${req.protocol}://${req.headers.host ?? ''}`;
  if (
    !isBootstrapRequestAllowed({
      origin: req.get('origin'),
      secFetchSite: req.get('sec-fetch-site'),
      expectedOrigin,
      allowedOrigins: DEV_ORIGINS,
    })
  ) {
    res.status(403).json({
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'The bootstrap request must come from the MyLens app itself.',
      },
    });
    return;
  }
  try {
    const [profiles, providers, settings] = await Promise.all([
      listProfiles(),
      listProviders(),
      getSettings(),
    ]);
    const payload: BootstrapInfo = {
      appName: APP_NAME,
      version: APP_VERSION,
      token: API_TOKEN,
      platform: process.platform,
      nodeVersion: process.version,
      dataDir: DATA_DIR,
      clientBuilt: fs.existsSync(path.join(CLIENT_DIST, 'index.html')),
      detectedXampp: detectXampp(),
      profiles,
      providers,
      settings,
      activeProfileId: null,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: payload });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res, next) => {
  const token = req.get('x-mylens-token');
  if (!token || token !== API_TOKEN) {
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'The local session token is missing or expired. Reload the app.',
      },
    });
    return;
  }
  next();
});

app.use('/api/connections', connectionsRouter);
app.use('/api/db', explorerRouter);
app.use('/api/db', queryRouter);
app.use('/api/db', metricsRouter);
app.use('/api/db', securityRouter);
app.use('/api/review', reviewRouter);
app.use('/api/ai', aiRouter);
app.use('/api/audit', auditRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/history', historyRouter);
app.use('/api/snippets', snippetsRouter);
app.use('/api/practice', practiceRouter);
app.use('/api/settings', settingsRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'API endpoint not found.' },
  });
});

const clientIndex = path.join(CLIENT_DIST, 'index.html');
if (fs.existsSync(clientIndex)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(clientIndex);
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><html><body style="font-family:Segoe UI,sans-serif;background:#080a0f;color:#e7edf7;padding:40px">
        <h1 style="color:#ff8a3d">MyLens API is running</h1>
        <p>The production UI has not been built yet.</p>
        <p>Run <code style="background:#1e2735;padding:2px 6px;border-radius:4px">npm run dev</code> and open
        <a style="color:#22d3a6" href="http://127.0.0.1:5174">http://127.0.0.1:5174</a>, or run
        <code style="background:#1e2735;padding:2px 6px;border-radius:4px">npm run build &amp;&amp; npm start</code>.</p>
        </body></html>`,
      );
  });
}

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        ...(err.sqlState ? { sqlState: err.sqlState } : {}),
        ...(err.errno ? { errno: err.errno } : {}),
      },
    });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' },
    });
    return;
  }
  const dbCandidate = err as { sqlMessage?: unknown; code?: unknown };
  if (
    typeof dbCandidate.sqlMessage === 'string' ||
    (typeof dbCandidate.code === 'string' &&
      (dbCandidate.code.startsWith('ER_') ||
        [
          'ECONNREFUSED',
          'ENOTFOUND',
          'EAI_AGAIN',
          'ETIMEDOUT',
          'PROTOCOL_SEQUENCE_TIMEOUT',
          'PROTOCOL_CONNECTION_LOST',
          'ER_QUERY_INTERRUPTED',
        ].includes(dbCandidate.code)))
  ) {
    const mapped = mapDbError(err);
    res.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.sqlState ? { sqlState: mapped.sqlState } : {}),
        ...(mapped.errno ? { errno: mapped.errno } : {}),
      },
    });
    return;
  }
  const error = err as Error;
  // Do not log request bodies; they can contain SQL and credentials.
  console.error(`[mylens] ${req.method} ${req.path}:`, error.message);
  if (process.env.MYLENS_DEBUG === '1') console.error(error.stack);
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Unexpected server error. Check the server console for details.',
    },
  });
});

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
  console.warn(
    `[mylens] Warning: binding to ${HOST} exposes the API beyond localhost. The token gate still applies, but this is not recommended.`,
  );
}

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  ${APP_NAME} ${APP_VERSION}`);
  console.log(`  API:  http://${HOST}:${PORT}`);
  console.log(
    fs.existsSync(clientIndex)
      ? `  UI:   http://${HOST}:${PORT}`
      : `  UI:   http://127.0.0.1:5174  (Vite dev server)`,
  );
  console.log(`  Data: ${DATA_DIR}`);
  console.log('  Mode: read-only by default · writes require an explicit unlock');
  console.log('');
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[mylens] Port ${PORT} is already in use. Stop the other process or set MYLENS_PORT.`,
    );
  } else {
    console.error('[mylens] Server error:', error.message);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mylens] ${signal} received; closing database pools.`);
  await shutdownPools();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
