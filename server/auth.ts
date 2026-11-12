import type { NextFunction, Request, Response } from 'express';
import type { PublicUser } from '../shared/types';
import { AppError } from './errors';
import { runWithRuntimeUser } from './runtime-context';
import { resolveSession, SESSION_COOKIE, parseSessionCookie } from './store/sessions';
import { findUserById } from './store/users';

/**
 * Session auth. The per-boot token gate proves the client is the app; the
 * session cookie proves which person is using it. Routes read `req.user`
 * (always present past the session gate) and derive access from its role.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export async function resolveSessionUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionId = parseSessionCookie(req.headers.cookie);
  const session = await resolveSession(sessionId);
  if (session) {
    const user = await findUserById(session.userId);
    if (user && !user.disabledAt) {
      req.user = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        assignments: user.assignments,
        createdAt: user.createdAt,
        disabledAt: user.disabledAt ?? null,
        theme: user.theme ?? null,
        // The per-account write lock travels with the session user so that
        // route code and the client see the same flag the policy enforces.
        writeUnlockDisabled: user.writeUnlockDisabled === true,
      };
    }
  }
  next();
}

/**
 * Carries the authenticated account through asynchronous provider work. AI
 * helpers are shared by several routes; an async context lets their global
 * concurrency guard schedule fairly without changing every helper signature.
 */
export function bindRuntimeUser(req: Request, _res: Response, next: NextFunction): void {
  runWithRuntimeUser(req.user?.id ?? null, next);
}

/** One response contract for a missing or stale expected owner assertion. */
export const EXPECTED_USER_ERROR = {
  code: 'EXPECTED_USER_MISMATCH',
  message:
    'The expected signed-in user is missing or no longer matches this session. Reload the app.',
} as const;

/**
 * Every authenticated app request must assert which account owns its state.
 * Missing and mismatched assertions are intentionally indistinguishable: in
 * either case the request may belong to a stale tab and must have no side
 * effect. Bootstrap, login, setup and /auth/me are mounted outside this gate.
 */
export function rejectUnexpectedUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    next();
    return;
  }
  const expected = req.get('x-mylens-expected-user-id');
  if (expected !== req.user.id) {
    res.status(409).json({ error: EXPECTED_USER_ERROR });
    return;
  }
  next();
}

/** Private authenticated API data must never be reused by a shared cache. */
export function privateAuthenticatedResponse(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Vary', 'Cookie, x-mylens-expected-user-id');
  }
  next();
}

export function currentUser(req: Request): PublicUser {
  if (!req.user) {
    throw new AppError('AUTH_REQUIRED', 'Sign in to use the app.', 401);
  }
  return req.user;
}

export function requireAdmin(req: Request): PublicUser {
  const user = currentUser(req);
  if (user.role !== 'admin') {
    throw new AppError('ADMIN_REQUIRED', 'Only an admin can do that.', 403);
  }
  return user;
}

/**
 * Members may only touch connections assigned to them; admins pass freely.
 */
export function assertProfileAssigned(req: Request, profileId: string): PublicUser {
  const user = currentUser(req);
  if (user.role === 'admin') return user;
  if (!user.assignments.some((assignment) => assignment.profileId === profileId)) {
    throw new AppError(
      'PROFILE_NOT_ASSIGNED',
      'This connection is not assigned to your account.',
      403,
    );
  }
  return user;
}

export interface ScopeOverride {
  allowed: string[];
}

/**
 * The effective scope override for a member: only the sandbox databases
 * provisioned from this profile. Admins get the profile's own scope
 * (undefined = no override). A missing user or a member without an
 * assignment for the profile gets an empty set, so every database check
 * fails closed.
 */
export function sandboxScopeOverride(
  user: PublicUser | undefined,
  profileId: string,
): ScopeOverride | undefined {
  if (!user) return { allowed: [] };
  if (user.role === 'admin') return undefined;
  return {
    allowed: user.assignments
      .filter((assignment) => assignment.profileId === profileId)
      .map((assignment) => assignment.sandbox),
  };
}

export { SESSION_COOKIE };
