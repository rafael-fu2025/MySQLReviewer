import { Router } from 'express';
import { z } from 'zod';
import type { Request } from 'express';
import { AppError } from '../errors';
import {
  clearCookieHeader,
  createSession,
  deleteSession,
  parseSessionCookie,
  sessionCookieHeader,
} from '../store/sessions';
import { countUsers, createUser, findUserByUsername, verifyLogin } from '../store/users';
import { logActivity } from '../store/activity';
import { currentUser } from '../auth';
import { parseBody } from './util';

const router = Router();

const CredentialsSchema = z.object({
  username: z.string().trim().min(2).max(40),
  password: z.string().min(6).max(200),
  displayName: z.string().trim().max(80).optional(),
});

const LoginSchema = CredentialsSchema.omit({ displayName: true });

/* -------------------------------------------------------------------------- */
/* Brute-force protection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The sign-in route is reachable without a session, so failed attempts are
 * counted per account and per client address. Too many failures lock the pair
 * out for a cooling-off period instead of letting the caller guess forever.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_LIMIT = 5;
const ACCOUNT_LOCK_MS = 15 * 60 * 1000;
const ADDRESS_LIMIT = 20;
const ADDRESS_LOCK_MS = 5 * 60 * 1000;

interface LoginPolicy {
  limit: number;
  lockMs: number;
}

interface AttemptState {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const loginAttempts = new Map<string, AttemptState>();

function accountKey(username: string): string {
  return `user:${username.trim().toLowerCase()}`;
}

/** The peer address of the connection; a client-supplied header is not trusted. */
function addressKey(req: Request): string {
  return `addr:${req.socket?.remoteAddress ?? 'unknown'}`;
}

function lockExpiry(key: string, now: number): number {
  const state = loginAttempts.get(key);
  if (!state) return 0;
  if (now - state.firstFailureAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return 0;
  }
  return state.lockedUntil;
}

/** Throws a 429 when the account or the client address is locked out. */
export function assertLoginAllowed(username: string, req: Request): void {
  const now = Date.now();
  for (const key of [accountKey(username), addressKey(req)]) {
    const until = lockExpiry(key, now);
    if (until > now) {
      throw new AppError(
        'TOO_MANY_ATTEMPTS',
        'Too many failed sign-in attempts. Try again later.',
        429,
        { retryAfterSeconds: Math.ceil((until - now) / 1000) },
      );
    }
  }
}

/** Counts one failed attempt. Unknown accounts only count against the address. */
export function recordLoginFailure(username: string, req: Request, accountExists: boolean): void {
  const now = Date.now();
  const policies: Array<[string, LoginPolicy]> = [
    [addressKey(req), { limit: ADDRESS_LIMIT, lockMs: ADDRESS_LOCK_MS }],
  ];
  if (accountExists)
    policies.push([accountKey(username), { limit: ACCOUNT_LIMIT, lockMs: ACCOUNT_LOCK_MS }]);
  for (const [key, policy] of policies) {
    const state = loginAttempts.get(key);
    if (!state || now - state.firstFailureAt > LOGIN_WINDOW_MS) {
      loginAttempts.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
      continue;
    }
    state.failures += 1;
    if (state.failures >= policy.limit) state.lockedUntil = now + policy.lockMs;
  }
}

/** A successful sign-in clears the counters of that account and address. */
export function clearLoginFailures(username: string, req: Request): void {
  loginAttempts.delete(accountKey(username));
  loginAttempts.delete(addressKey(req));
}

/** Test hook: forgets every recorded attempt. */
export function resetLoginThrottle(): void {
  loginAttempts.clear();
}

router.post('/setup', async (req, res, next) => {
  try {
    if ((await countUsers()) > 0) {
      throw new AppError('SETUP_DONE', 'The admin account already exists.', 403);
    }
    const body = parseBody(CredentialsSchema, req);
    const user = await createUser({
      username: body.username,
      displayName: body.displayName ?? body.username,
      password: body.password,
      role: 'admin',
    });
    const session = await createSession(user.id);
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'admin-user-create',
      detail: 'Admin account created during setup',
    });
    res.setHeader('Set-Cookie', sessionCookieHeader(session));
    res.json({ data: { user } });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const body = parseBody(LoginSchema, req);
    assertLoginAllowed(body.username, req);
    const user = await verifyLogin(body.username, body.password);
    if (!user) {
      const known = await findUserByUsername(body.username);
      recordLoginFailure(body.username, req, known !== null);
      throw new AppError('INVALID_CREDENTIALS', 'Wrong username or password.', 401);
    }
    clearLoginFailures(body.username, req);
    const session = await createSession(user.id);
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'login',
    });
    res.setHeader('Set-Cookie', sessionCookieHeader(session));
    res.json({
      data: {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          assignments: user.assignments,
          createdAt: user.createdAt,
          disabledAt: user.disabledAt ?? null,
          theme: user.theme ?? null,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const sessionId = parseSessionCookie(req.headers.cookie);
    if (req.user) {
      await logActivity({
        userId: req.user.id,
        username: req.user.username,
        action: 'logout',
      });
    }
    await deleteSession(sessionId);
    res.setHeader('Set-Cookie', clearCookieHeader());
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

router.get('/me', (req, res) => {
  try {
    res.json({ data: { user: currentUser(req) } });
  } catch {
    res.json({ data: { user: null } });
  }
});

export { router as authRouter };
