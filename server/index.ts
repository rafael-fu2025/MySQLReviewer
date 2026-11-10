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
  storageConfig,
} from './config';
import { AppError, mapDbError } from './errors';
import { isBootstrapRequestAllowed } from './bootstrap-origin';
import { shutdownPools } from './db/manager';
import { shutdownMcp } from './ai/agent-mcp';
import { startScheduler, stopScheduler } from './scheduler';
import { resolveSessionUser } from './auth';
import {
  closeDocumentBackend,
  describeStorage,
  getDocumentBackend,
  redactStorageUri,
} from './store/document-backend';
import { countUsers } from './store/users';
import { listProfiles } from './store/profiles';
import { listProviders } from './store/providers';
import { getSettings } from './store/settings';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
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
import { workspaceRouter } from './routes/workspace';
import type {
  AiProvider,
  AppSettings,
  BootstrapInfo,
  ConnectionProfile,
  PublicUser,
} from '../shared/types';

ensureDataDirs();

const API_TOKEN = crypto.randomBytes(32).toString('hex');
/**
 * The server only ever listens on a loopback address unless the operator
 * explicitly opts out with MYLENS_ALLOW_REMOTE_HOST=1.
 */
const ALLOW_REMOTE_HOST = process.env.MYLENS_ALLOW_REMOTE_HOST === '1';
/** The test-suite imports this module; it must not open a listening socket. */
const SHOULD_LISTEN = process.env.MYLENS_NO_LISTEN !== '1';
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

/** True for the loopback names and addresses the server may bind to. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  return false;
}

/**
 * True for a loopback peer address. The socket peer is the only network
 * boundary the server can trust: a `Host` header is sent by the client and
 * proves nothing.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.toLowerCase();
  if (value === '::1' || value === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

export interface BindDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Whether the server may bind to the given host. A non-loopback bind is
 * refused unless the operator opted in explicitly.
 */
export function evaluateBindHost(host: string, allowRemote: boolean): BindDecision {
  if (allowRemote) return { allowed: true, reason: null };
  if (isLoopbackHost(host)) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason:
      `MyLens refuses to listen on ${host}: it serves loopback addresses only. ` +
      'Set MYLENS_ALLOW_REMOTE_HOST=1 to override, and put a real authentication proxy in front of it.',
  };
}

/**
 * The app renders model-controlled markdown, so the document must not trust
 * anything but its own origin. The built SPA has no inline scripts (Vite
 * emits one external `<script type="module">`), fonts and the favicon are
 * bundled assets, and CodeMirror/React only inject inline `style` attributes
 * — hence the single `'unsafe-inline'` under `style-src`.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

  // The network boundary is the socket peer, not a header the client sends.
  if (!ALLOW_REMOTE_HOST && !isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({
      error: {
        code: 'PEER_NOT_ALLOWED',
        message: 'This app only accepts connections from this machine.',
      },
    });
    return;
  }

  // A `Host` header is client-controlled. It is kept as a DNS-rebinding
  // guard only; it is never treated as the network boundary.
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

// Resolves the signed-in user (if any) for every /api request, including
// bootstrap and auth themselves. Never rejects on its own.
app.use('/api', resolveSessionUser);

app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    data: { ok: true, app: APP_NAME, version: APP_VERSION, storage: describeStorage() },
  });
});

/**
 * Builds the bootstrap payload.
 *
 * The master API token, the connection profiles and the AI providers are
 * secrets of the installation: they are only handed to a caller that has
 * already signed in. An anonymous caller gets the bare minimum it needs to
 * show the sign-in screen.
 */
export function buildBootstrapPayload(input: {
  needsSetup: boolean;
  user: PublicUser | null;
  profiles: ConnectionProfile[];
  providers: AiProvider[];
  settings: AppSettings;
  apiToken: string;
}): BootstrapInfo {
  const user = input.user;
  const authenticated = user !== null;
  // Members see only the connections assigned to them; admins see all.
  const profiles = !authenticated
    ? []
    : user.role === 'member'
      ? input.profiles.filter((profile) =>
          user.assignments.some((assignment) => assignment.profileId === profile.id),
        )
      : input.profiles;
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    token: authenticated ? input.apiToken : '',
    platform: process.platform,
    nodeVersion: process.version,
    dataDir: DATA_DIR,
    clientBuilt: fs.existsSync(path.join(CLIENT_DIST, 'index.html')),
    detectedXampp: detectXampp(),
    profiles,
    providers: authenticated ? input.providers : [],
    settings: { ...input.settings, theme: user?.theme ?? input.settings.theme },
    activeProfileId: null,
    auth: { needsSetup: input.needsSetup },
    currentUser: user,
  };
}

app.get('/api/bootstrap', async (req, res, next) => {
  const expectedOrigin = `${req.protocol}://${req.headers.host ?? ''}`;
  if (
    !isBootstrapRequestAllowed({
      origin: req.get('origin'),
      secFetchSite: req.get('sec-fetch-site'),
      accept: req.get('accept'),
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
    const needsSetup = (await countUsers()) === 0;
    const user = req.user ?? null;
    const [allProfiles, providers, settings] = await Promise.all([
      listProfiles(),
      listProviders(),
      getSettings(),
    ]);
    const payload = buildBootstrapPayload({
      needsSetup,
      user,
      profiles: allProfiles,
      providers,
      settings,
      apiToken: API_TOKEN,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: payload });
  } catch (error) {
    next(error);
  }
});

// The sign-in routes must be reachable before the caller owns the master
// token: the token is only handed out after a successful sign-in.
app.use('/api/auth', authRouter);

/**
 * Compares the presented token against the expected one in constant time.
 * Both sides are hashed first so the digests always have the same length:
 * the comparison never leaks the expected token's length, and mismatched
 * lengths take exactly the same code path as matching ones.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const presentedDigest = crypto.createHash('sha256').update(presented).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(presentedDigest, expectedDigest);
}

app.use('/api', (req, res, next) => {
  const token = req.get('x-mylens-token');
  // A signed-in session is accepted as well: the session cookie is the
  // credential of the browser app, and it is only set after a sign-in.
  if ((!token || !tokenMatches(token, API_TOKEN)) && !req.user) {
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

// Everything after the session gate below requires a signed-in user.
app.use('/api', (req, res, next) => {
  if (!req.user) {
    res.status(401).json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Sign in to use the app.',
      },
    });
    return;
  }
  next();
});

app.use('/api/admin', adminRouter);
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
app.use('/api/workspace', workspaceRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'API endpoint not found.' },
  });
});

const clientIndex = path.join(CLIENT_DIST, 'index.html');
if (fs.existsSync(clientIndex)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  // A missing hashed asset must not receive the SPA HTML document: JavaScript
  // import() would fail with a confusing MIME/parse error instead of a 404.
  app.get('/assets/*', (_req, res) => {
    res.status(404).type('text/plain').send('Asset not found.');
  });
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    // index.html owns the current chunk hashes; it must never be cached across
    // a rebuild, or the browser keeps requesting assets that no longer exist.
    res.setHeader('Cache-Control', 'no-store');
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

if (SHOULD_LISTEN) {
  const bind = evaluateBindHost(HOST, ALLOW_REMOTE_HOST);
  if (!bind.allowed) {
    console.error(`[mylens] ${bind.reason}`);
    process.exit(1);
  }
  if (ALLOW_REMOTE_HOST && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn(
      `[mylens] Warning: MYLENS_ALLOW_REMOTE_HOST=1 is set, so the API listens on ${HOST} and is reachable from the network. Put a real authentication proxy in front of it.`,
    );
  }

  // In MySQL mode the app cannot serve without its storage backend: fail fast
  // during startup instead of answering every request with an error. The ping
  // also creates the schema and runs the one-time legacy import, so by the
  // time the API accepts requests the storage is ready. (Json mode needs no
  // ping and never refuses to boot.)
  if (storageConfig.mode === 'mysql') {
    try {
      await getDocumentBackend().ping();
    } catch (error) {
      console.error(
        `[mylens] storage: MySQL unreachable at ${redactStorageUri(storageConfig.mysql.uri)} — the app cannot serve without its storage backend`,
      );
      console.error(`[mylens] storage: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
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
    shutdownMcp();
    stopScheduler();
    await shutdownPools();
    await closeDocumentBackend();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Recurring deterministic audits; a no-op under MYLENS_NO_LISTEN (tests).
  startScheduler();
}
