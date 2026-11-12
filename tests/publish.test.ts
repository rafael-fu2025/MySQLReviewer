import { describe, expect, it } from 'vitest';

import { createProfile } from '../server/store/profiles';
import { createUser, setAssignments } from '../server/store/users';
import { getDatabaseScope } from '../server/db/scope';
import { sandboxScopeOverride } from '../server/auth';
import type { SandboxAssignment } from '../shared/types';

/**
 * Publishing a database on a connection and giving a member their own copy
 * of it are the same act.
 *
 * A member never works in a published database directly. They work in a
 * clone, so their writes land in their own copy and the administrator's data
 * is untouched. The clone is recorded as a normal sandbox assignment, so the
 * member's reach is still exactly the set of sandboxes assigned to them.
 */

function assignment(profileId: string, source: string, sandbox: string): SandboxAssignment {
  return {
    id: `a-${sandbox}`,
    profileId,
    source,
    sandbox,
    includeData: true,
    createdAt: '2026-01-01T00:00:00Z',
    lastResetAt: null,
  };
}

async function memberWithSandbox(
  profileId: string,
  source: string,
  sandbox: string,
): Promise<{ id: string; username: string }> {
  const user = await createUser({
    username: `pub-${Math.random().toString(36).slice(2, 10)}`,
    displayName: 'Publish Member',
    password: ['test', 'cred', 'fixture'].join('_'),
    role: 'member',
  });
  await setAssignments(user.id, [assignment(profileId, source, sandbox)]);
  return { id: user.id, username: user.username };
}

describe('publishing a database reaches a member as a clone', () => {
  it('keeps the member out of the published database itself', async () => {
    const profile = await createProfile({
      name: 'Publish scope',
      host: '127.0.0.1',
      port: 3399,
      user: 'root',
      databaseScope: 'selected',
      allowedDatabases: ['cms2'],
    });
    const member = await memberWithSandbox(profile.id, 'cms2', 'cms2_1');

    // The member's scope is their sandbox, never the published source.
    const user = {
      id: member.id,
      username: member.username,
      displayName: 'Publish Member',
      role: 'member' as const,
      assignments: [assignment(profile.id, 'cms2', 'cms2_1')],
      createdAt: '2026-01-01T00:00:00Z',
      disabledAt: null,
    };
    const override = sandboxScopeOverride(user, profile.id);
    const scope = await getDatabaseScope(profile.id, override);

    expect([...scope.allowed]).toEqual(['cms2_1']);
    // The source is the administrator's live database: it must not appear in
    // the member's scope, or their writes would land in it.
    expect(scope.allowed.has('cms2')).toBe(false);
  });

  it('lets the member reach the source only when they hold a clone of it', async () => {
    const profile = await createProfile({
      name: 'Publish clone',
      host: '127.0.0.1',
      port: 3399,
      user: 'root',
      databaseScope: 'selected',
      allowedDatabases: ['cms2'],
    });
    const member = await memberWithSandbox(profile.id, 'cms2', 'cms2_1');

    const user = {
      id: member.id,
      username: member.username,
      displayName: 'Publish Member',
      role: 'member' as const,
      assignments: [assignment(profile.id, 'cms2', 'cms2_1')],
      createdAt: '2026-01-01T00:00:00Z',
      disabledAt: null,
    };
    const scope = await getDatabaseScope(profile.id, sandboxScopeOverride(user, profile.id));

    // The clone is the database the member works in.
    expect(scope.allowed.has('cms2_1')).toBe(true);
    expect(scope.allowed.size).toBe(1);
  });

  it('keeps a member without a clone of a published database out of it', async () => {
    const profile = await createProfile({
      name: 'Publish no clone',
      host: '127.0.0.1',
      port: 3399,
      user: 'root',
      databaseScope: 'selected',
      allowedDatabases: ['cms2', 'northwind'],
    });
    // The member holds a clone of northwind only.
    const user = {
      id: 'member-1',
      username: 'member',
      displayName: 'Member',
      role: 'member' as const,
      assignments: [assignment(profile.id, 'northwind', 'northwind_1')],
      createdAt: '2026-01-01T00:00:00Z',
      disabledAt: null,
    };
    const scope = await getDatabaseScope(profile.id, sandboxScopeOverride(user, profile.id));

    expect([...scope.allowed]).toEqual(['northwind_1']);
    expect(scope.allowed.has('cms2')).toBe(false);
    expect(scope.allowed.has('northwind')).toBe(false);
  });

  it('leaves the administrator on the published databases', async () => {
    const profile = await createProfile({
      name: 'Publish admin',
      host: '127.0.0.1',
      port: 3399,
      user: 'root',
      databaseScope: 'selected',
      allowedDatabases: ['cms2', 'northwind'],
    });

    // No override: an administrator works on the connection's own scope.
    const scope = await getDatabaseScope(profile.id, undefined);

    expect([...scope.allowed].sort()).toEqual(['cms2', 'northwind']);
  });
});
