import type { SandboxAssignment } from '../../shared/types';
import { AppError } from '../errors';
import { invalidateSchemaCache } from './introspection';
import { nextSandboxName, provisionSandbox } from './provision';
import { getStoredProfile } from '../store/profiles';
import { listUsers, addAssignment } from '../store/users';
import crypto from 'node:crypto';

/**
 * Publishing a database on a connection and giving a member their own copy
 * of it are the same act.
 *
 * A connection's allowlist names the *source* databases the administrator
 * opened the connection for. A member never works in those directly: they work
 * in a clone, so their writes land in their own copy and the administrator's
 * data is untouched. That is the same guarantee the sandbox provisioner has
 * always given, so publishing a database now provisions a clone per member
 * instead of handing them the live schema.
 *
 * The clone is recorded as a normal sandbox assignment, so every existing
 * scope check keeps working unchanged: the member's reach is still exactly
 * the set of sandboxes assigned to them.
 */

/** The result of publishing one source database to the members of a connection. */
export interface PublishResult {
  source: string;
  /** The sandbox each member received, keyed by user id. */
  sandboxes: Array<{ userId: string; username: string; sandbox: string }>;
  /** Members who already had a clone of this source; they were left alone. */
  skipped: string[];
  /** Databases that could not be cloned, with the reason. */
  errors: string[];
}

/**
 * The clone name a member's copy of `source` would get.
 *
 * The counter is per source database and is derived from what exists on the
 * server, so two members never receive the same clone and a clone made
 * outside the app never collides either.
 */
async function cloneNameFor(
  profileId: string,
  source: string,
  taken: Set<string>,
): Promise<string> {
  let candidate = await nextSandboxName(profileId, source);
  // The server knows about every clone on it; `taken` holds the ones this
  // run is about to create, which the server does not know yet.
  while (taken.has(candidate.toLowerCase())) {
    const suffix = Number.parseInt(candidate.slice(source.length + 1), 10);
    candidate = `${source}_${(Number.isFinite(suffix) ? suffix : 0) + 1}`;
  }
  return candidate;
}

/**
 * Publishes one source database to every member assigned to the connection:
 * each member receives a clone, and the clone is recorded as their sandbox.
 */
export async function publishDatabaseToMembers(
  profileId: string,
  source: string,
  options: { includeData?: boolean } = {},
): Promise<PublishResult> {
  const includeData = options.includeData !== false;
  const result: PublishResult = { source, sandboxes: [], skipped: [], errors: [] };

  const profile = await getStoredProfile(profileId);
  if (profile.databaseScope !== 'selected') {
    throw new AppError(
      'VALIDATION',
      'Publish a database on a connection that is limited to selected databases.',
      400,
    );
  }
  if (!profile.allowedDatabases?.includes(source)) {
    throw new AppError(
      'VALIDATION',
      `The database "${source}" is not published on this connection.`,
      400,
    );
  }

  const members = (await listUsers()).filter(
    (user) =>
      user.role === 'member' &&
      // Only the members who can reach this connection at all: a member
      // without an assignment for it cannot open it, so a clone would be a
      // database nobody could use.
      user.assignments.some((assignment) => assignment.profileId === profileId),
  );
  // The clones this run creates are not on the server yet, so the name
  // allocator cannot see them.
  const taken = new Set<string>();

  for (const member of members) {
    const assigned = member.assignments.some(
      (assignment: SandboxAssignment) =>
        assignment.profileId === profileId && assignment.source === source,
    );
    if (assigned) {
      result.skipped.push(member.username);
      continue;
    }
    try {
      const sandbox = await cloneNameFor(profileId, source, taken);
      taken.add(sandbox.toLowerCase());
      const provision = await provisionSandbox(profileId, source, sandbox, includeData);
      const assignment: SandboxAssignment = {
        id: crypto.randomBytes(6).toString('base64url'),
        profileId,
        source,
        sandbox: provision.sandbox,
        includeData,
        createdAt: new Date().toISOString(),
        lastResetAt: null,
      };
      const updated = await addAssignment(member.id, assignment);
      if (!updated) {
        result.errors.push(`${member.username}: the account no longer exists.`);
        continue;
      }
      invalidateSchemaCache(profileId, provision.sandbox);
      result.sandboxes.push({
        userId: member.id,
        username: member.username,
        sandbox: provision.sandbox,
      });
      if (!provision.complete || provision.dataErrors.length > 0) {
        result.errors.push(
          `${member.username}: ${provision.sandbox} was cloned but some tables could not be copied (${provision.dataErrors.join('; ')}).`,
        );
      }
    } catch (error) {
      result.errors.push(
        `${member.username}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}

/**
 * Publishes every database the connection's allowlist names to every member
 * assigned to it. Used after the allowlist changes, so a database the
 * administrator just published reaches the members as a clone.
 */
export async function publishAllToMembers(
  profileId: string,
  options: { includeData?: boolean } = {},
): Promise<PublishResult[]> {
  const profile = await getStoredProfile(profileId);
  if (profile.databaseScope !== 'selected') return [];
  const results: PublishResult[] = [];
  for (const source of profile.allowedDatabases ?? []) {
    results.push(await publishDatabaseToMembers(profileId, source, options));
  }
  return results;
}
