import crypto from 'node:crypto';
import path from 'node:path';
import type { PublicUser, SandboxAssignment, ThemePreference, UserRole } from '../../shared/types';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import { JsonStore } from './json-store';
import { deleteSessionsForUser } from './sessions';
import { getSettings } from './settings';
import { getStoredProfile } from './profiles';
import { deleteConversationsForUser } from './conversations';
import { deleteHistoryForUser } from './history';
import { deleteSnippetsForUser } from './snippets';
import { deletePracticeDataForUser } from './practice';
import { deleteWorkspace } from './workspace';
import { isWritesUnlocked, revokeWriteGrantsForUser } from '../db/manager';

/**
 * App accounts. Roles: `admin` manages users, connections and sandboxes;
 * `member` uses only the connections assigned to them and works exclusively
 * inside the sandbox databases provisioned for those assignments.
 */
export interface StoredUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  /** `scrypt$<salt hex>$<hash hex>` — verified with timingSafeEqual. */
  passwordHash: string;
  assignments: SandboxAssignment[];
  createdAt: string;
  disabledAt?: string | null;
  /** Personal appearance override; absent means the app default applies. */
  theme?: ThemePreference;
  /**
   * When true this account can never unlock writes, even while the global
   * write-unlock switch is on. Absent means "not disabled" — a users file
   * written before this flag existed keeps working unchanged.
   */
  writeUnlockDisabled?: boolean;
}

interface UsersFile {
  users: StoredUser[];
}

const SCRYPT_KEYLEN = 64;
const MAX_USERS = 100;

function usersFile(): string {
  return path.join(DATA_DIR, 'users.json');
}

const store = new JsonStore<UsersFile>(usersFile(), () => ({ users: [] }));

/**
 * The accounts whose write unlocking is blocked.
 *
 * The write gate has to answer without waiting for the users document, so the
 * flag is mirrored in memory. Every write to the document refreshes the
 * mirror, and the document is read once when the module loads.
 */
const writeUnlockBlocked = new Set<string>();

/** True when this account may never unlock writes. */
export function isWriteUnlockBlocked(id: string): boolean {
  return writeUnlockBlocked.has(id);
}

/**
 * Rebuilds the in-memory mirror from the document. Only needed when the
 * document changed outside this module.
 */
export async function refreshWriteUnlockMirror(): Promise<void> {
  await store.read();
  const document = await store.read();
  writeUnlockBlocked.clear();
  for (const user of document.users) {
    if (user.role !== 'admin' && user.writeUnlockDisabled === true) writeUnlockBlocked.add(user.id);
  }
}

/** Keeps the in-memory mirror in step with the document. */
function rememberWriteUnlockBlock(user: StoredUser): void {
  if (user.role !== 'admin' && user.writeUnlockDisabled === true) writeUnlockBlocked.add(user.id);
  else writeUnlockBlocked.delete(user.id);
}

/**
 * Reads the document once so the mirror is complete before the first request
 * is answered.
 */
void refreshWriteUnlockMirror().catch(() => undefined);

function newId(): string {
  return crypto.randomBytes(9).toString('base64url');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  // Degenerate buffers (bad hex, zero length) must never verify — require the
  // exact dimensions hashPassword produces before the comparison.
  if (salt.length < 16 || expected.length < SCRYPT_KEYLEN) return false;
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function toPublic(user: StoredUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    // A copy: the caller must not be able to reach into the stored account.
    assignments: user.assignments.map((assignment) => ({ ...assignment })),
    createdAt: user.createdAt,
    disabledAt: user.disabledAt ?? null,
    theme: user.theme ?? null,
    writeUnlockDisabled: user.role === 'admin' ? false : user.writeUnlockDisabled === true,
  };
}

/**
 * Replaces one account inside the users document. The mutator runs inside the
 * store's serialization queue, so no concurrent writer can lose an update.
 */
async function updateAccount(
  id: string,
  mutate: (user: StoredUser) => StoredUser,
): Promise<StoredUser | null> {
  const file = await store.update((current) => {
    const index = current.users.findIndex((entry) => entry.id === id);
    if (index < 0) return current;
    const users = [...current.users];
    users[index] = mutate(current.users[index]);
    return { users };
  });
  const updated = file.users.find((entry) => entry.id === id) ?? null;
  if (updated) rememberWriteUnlockBlock(updated);
  return updated;
}

export async function countUsers(): Promise<number> {
  return (await store.read()).users.length;
}

export async function listUsers(): Promise<PublicUser[]> {
  return (await store.read()).users.map(toPublic);
}

export async function findUserById(id: string): Promise<StoredUser | null> {
  return (await store.read()).users.find((user) => user.id === id) ?? null;
}

export async function findUserByUsername(username: string): Promise<StoredUser | null> {
  const needle = username.trim().toLowerCase();
  return (await store.read()).users.find((user) => user.username.toLowerCase() === needle) ?? null;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
}): Promise<PublicUser> {
  return createUserInternal(input, false);
}

/**
 * Atomically creates the installation's first account as an administrator.
 * The empty check and insertion share one store update, so two setup requests
 * can never both pass a separate countUsers() check.
 */
export async function createFirstAdmin(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<PublicUser> {
  return createUserInternal({ ...input, role: 'admin' }, true);
}

async function createUserInternal(
  input: {
    username: string;
    displayName: string;
    password: string;
    role: UserRole;
  },
  requireEmpty: boolean,
): Promise<PublicUser> {
  const username = input.username.trim();
  const user: StoredUser = {
    id: newId(),
    username,
    displayName: input.displayName.trim() || username,
    role: input.role,
    passwordHash: hashPassword(input.password),
    assignments: [],
    createdAt: new Date().toISOString(),
    disabledAt: null,
  };
  // The uniqueness check and the capacity check run inside the store's
  // serialization queue, so two concurrent sign-ups cannot both claim the
  // same name and the account cap can never be exceeded.
  await store.update((current) => {
    if (requireEmpty && current.users.length > 0) {
      throw new AppError('SETUP_DONE', 'The admin account already exists.', 403);
    }
    const needle = username.toLowerCase();
    const existing = current.users.find((entry) => entry.username.toLowerCase() === needle);
    if (existing) {
      throw new AppError('USERNAME_TAKEN', `The username "${username}" is already taken.`, 409);
    }
    if (current.users.length >= MAX_USERS) {
      throw new AppError(
        'LIMIT_REACHED',
        `This app supports at most ${MAX_USERS} accounts. Delete an account before adding one.`,
        400,
      );
    }
    return { users: [...current.users, user] };
  });
  rememberWriteUnlockBlock(user);
  return toPublic(user);
}

export async function updateUser(
  id: string,
  patch: { displayName?: string; disabled?: boolean; password?: string },
): Promise<PublicUser | null> {
  const updated = await updateAccount(id, (user) => ({
    ...user,
    displayName:
      patch.displayName !== undefined
        ? patch.displayName.trim() || user.displayName
        : user.displayName,
    disabledAt:
      patch.disabled !== undefined
        ? patch.disabled
          ? new Date().toISOString()
          : null
        : user.disabledAt,
    passwordHash: patch.password !== undefined ? hashPassword(patch.password) : user.passwordHash,
  }));
  if (!updated) return null;
  // A password change or disable takes effect immediately for every bearer
  // credential and every personal write grant.
  if (patch.password !== undefined || patch.disabled === true) {
    await deleteSessionsForUser(id);
    revokeWriteGrantsForUser(id);
  }
  return toPublic(updated);
}

export async function deleteUser(id: string): Promise<boolean> {
  let removed = false;
  await store.update((current) => {
    const users = current.users.filter((user) => user.id !== id);
    removed = users.length !== current.users.length;
    return { users };
  });
  if (!removed) return false;

  writeUnlockBlocked.delete(id);
  revokeWriteGrantsForUser(id);
  // Account deletion is logical application cleanup only. Sandboxes and source
  // databases are never dropped here; an administrator can review and remove a
  // physical sandbox explicitly through the assignment route.
  await Promise.all([
    deleteSessionsForUser(id),
    deleteWorkspace(id),
    deleteConversationsForUser(id),
    deleteHistoryForUser(id),
    deleteSnippetsForUser(id),
    deletePracticeDataForUser(id),
  ]);
  return true;
}

export async function setAssignments(
  id: string,
  assignments: SandboxAssignment[],
): Promise<PublicUser | null> {
  const updated = await updateAccount(id, (user) => ({ ...user, assignments }));
  return updated ? toPublic(updated) : null;
}

/**
 * Appends one sandbox assignment without reading the account first, so two
 * concurrent provisions cannot wipe each other's assignment.
 */
export async function addAssignment(
  id: string,
  assignment: SandboxAssignment,
): Promise<PublicUser | null> {
  const updated = await updateAccount(id, (user) => {
    const duplicate = user.assignments.find(
      (entry) => entry.profileId === assignment.profileId && entry.source === assignment.source,
    );
    if (duplicate) {
      throw new AppError(
        'ASSIGNMENT_EXISTS',
        `"${user.username}" already has the sandbox "${duplicate.sandbox}" for ${assignment.source}.`,
        409,
      );
    }
    return { ...user, assignments: [...user.assignments, assignment] };
  });
  return updated ? toPublic(updated) : null;
}

/** Updates one sandbox assignment in place, without replacing the whole list. */
export async function patchAssignment(
  id: string,
  assignmentId: string,
  patch: Partial<SandboxAssignment>,
): Promise<PublicUser | null> {
  const updated = await updateAccount(id, (user) => ({
    ...user,
    assignments: user.assignments.map((entry) =>
      entry.id === assignmentId ? { ...entry, ...patch } : entry,
    ),
  }));
  return updated ? toPublic(updated) : null;
}

/** Removes one sandbox assignment without replacing the whole list. */
export async function removeAssignment(
  id: string,
  assignmentId: string,
): Promise<PublicUser | null> {
  const updated = await updateAccount(id, (user) => ({
    ...user,
    assignments: user.assignments.filter((entry) => entry.id !== assignmentId),
  }));
  return updated ? toPublic(updated) : null;
}

/** Persists one account's appearance override without touching admin defaults. */
export async function setUserTheme(id: string, theme: ThemePreference): Promise<PublicUser | null> {
  const updated = await updateAccount(id, (user) => ({ ...user, theme }));
  return updated ? toPublic(updated) : null;
}

/**
 * Turns the per-account write lock on or off. While it is on the account can
 * never unlock writes, no matter what the global switch says. Admin accounts
 * always have unrestricted write access and cannot be locked.
 */
export async function setWriteUnlockDisabled(
  id: string,
  disabled: boolean,
): Promise<PublicUser | null> {
  const existing = await findUserById(id);
  if (existing?.role === 'admin') {
    throw new AppError(
      'ADMIN_WRITE_UNLOCK_NOT_APPLICABLE',
      'Admin accounts always have full write access and cannot be locked.',
      400,
    );
  }
  const updated = await updateAccount(id, (user) => ({
    ...user,
    writeUnlockDisabled: disabled,
  }));
  return updated ? toPublic(updated) : null;
}

/* ------------------------------------------------------------------ */
/* Write-unlock policy                                                 */
/* ------------------------------------------------------------------ */

/**
 * Who forbids write unlocking for an account.
 *
 * - `global`: the administrator closed write unlocking for the whole app.
 * - `connection`: the connection itself is read-only for members.
 * - `account`: this one account is locked out.
 */
export type WriteUnlockBlocker = 'global' | 'connection' | 'account';

export interface WriteUnlockDecision {
  /**
   * May this account hold a write grant at all? `false` when the policy
   * forbids unlocking, whatever grant may still sit in memory.
   */
  permitted: boolean;
  /** May this account run write statements right now? */
  allowed: boolean;
  /** Who forbids it, when `permitted` is false. */
  blocker: WriteUnlockBlocker | null;
  /** A user-facing explanation of the block; empty when unlocking is permitted. */
  message: string;
}

const GLOBAL_DISABLED_MESSAGE =
  'Write unlocking is disabled for every account by an administrator. This app is in hard read-only mode.';

const ACCOUNT_DISABLED_MESSAGE =
  'Write unlocking is disabled for your account by an administrator.';

const CONNECTION_LOCKED_MESSAGE =
  'This connection is read-only for your account. An administrator has closed write access to it.';

/**
 * The one place where the write-unlock policy is decided.
 *
 * Admin accounts are completely unrestricted: they can execute write
 * statements, DDL, sensitive reveals, and database management freely without
 * ever needing to unlock writes.
 *
 * For members, the effective rule is `globalEnabled && !user.writeUnlockDisabled`:
 * the global switch can close write unlocking for everybody, and a per-account
 * lock can close one account while the rest of the app keeps working.
 *
 * `userId` names the account the grant belongs to.
 */
export async function resolveWriteUnlock(
  profileId: string,
  userId?: string | null,
): Promise<WriteUnlockDecision> {
  if (userId) {
    const user = await findUserById(userId);
    if (user?.role === 'admin') {
      return {
        permitted: true,
        allowed: true,
        blocker: null,
        message: '',
      };
    }
  }

  const settings = await getSettings();
  if (settings.writeUnlockEnabled === false) {
    // The global switch closes every grant for members.
    return {
      permitted: false,
      allowed: false,
      blocker: 'global',
      message: GLOBAL_DISABLED_MESSAGE,
    };
  }
  // The connection's own policy binds members.
  const profile = await getStoredProfile(profileId).catch(() => null);
  if (profile?.writeAccess === 'locked') {
    return {
      permitted: false,
      allowed: false,
      blocker: 'connection',
      message: CONNECTION_LOCKED_MESSAGE,
    };
  }
  if (userId && isWriteUnlockBlocked(userId)) {
    return {
      permitted: false,
      allowed: false,
      blocker: 'account',
      message: ACCOUNT_DISABLED_MESSAGE,
    };
  }
  return {
    permitted: true,
    allowed: isWritesUnlocked(profileId, userId),
    blocker: null,
    message: '',
  };
}

/**
 * May this account run write statements right now? Combines the global
 * switch, the per-account lock and the in-memory grant.
 */
export async function writeUnlockAllowedFor(
  profileId: string,
  userId?: string | null,
): Promise<boolean> {
  const decision = await resolveWriteUnlock(profileId, userId);
  return decision.permitted && decision.allowed;
}

export async function verifyLogin(username: string, password: string): Promise<StoredUser | null> {
  const user = await findUserByUsername(username);
  if (!user || user.disabledAt) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

export { store as usersStore, MAX_USERS };
