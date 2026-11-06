import type { NextFunction, Request, Response } from 'express';
import type { PublicUser } from '../shared/types';
import { AppError } from './errors';
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
