import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionProfile, PublicUser } from '@shared/types';
import { AdminUserCard } from '../src/pages/AdminPage';

function account(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: 'u-1',
    username: 'sherina',
    // The server falls back to the username when no display name was given.
    displayName: 'sherina',
    role: 'member',
    assignments: [],
    createdAt: '2026-01-15T08:30:00.000Z',
    disabledAt: null,
    writeUnlockDisabled: false,
    ...overrides,
  };
}

function connection(name: string): ConnectionProfile {
  return {
    id: 'p-1',
    name,
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    database: null,
    rememberPassword: false,
    hasPassword: true,
    passwordSource: 'saved',
    color: null,
    databaseScope: 'all',
    allowedDatabases: [],
    allowServerWideInsights: true,
    writeAccess: 'full',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
  };
}

function renderCard(user: PublicUser, profiles: ConnectionProfile[] = []): string {
  return renderToStaticMarkup(
    <AdminUserCard
      user={user}
      isCurrentUser={false}
      profiles={profiles}
      busy={null}
      onAssignSandbox={() => {}}
      onResetPassword={() => {}}
      onToggleDisabled={() => {}}
      onDeleteUser={() => {}}
      onResetSandbox={() => {}}
      onRemoveAssignment={() => {}}
      onToggleWriteUnlock={() => {}}
    />,
  );
}

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('Admin → Users write access', () => {
  it('does not render the write unlock switch for admin accounts', () => {
    const html = renderCard(account({ role: 'admin', username: 'rafael', displayName: 'Rafael' }));

    expect(html).not.toContain('Allow write unlocking');
    expect(html).not.toContain('Write access');
  });

  it('labels the switch with positive wording for member accounts', () => {
    const html = renderCard(account({ role: 'member' }));

    expect(html).toContain('Allow write unlocking');
    expect(html).not.toContain('Block write unlocking');
    expect(html).toContain('own connection');
  });

  it('reads the switch as positive: pressed means writes can be unlocked', () => {
    const allowed = renderCard(account({ role: 'member', writeUnlockDisabled: false }));
    const blocked = renderCard(account({ role: 'member', writeUnlockDisabled: true }));

    expect(allowed).toContain('aria-pressed="true"');
    expect(blocked).toContain('aria-pressed="false"');
  });
});

describe('Admin → Users account names', () => {
  it('shows one canonical display name and the username once', () => {
    const html = renderCard(account(), [connection('Northwind')]);

    // The canonical name is a display name, not a bare handle.
    expect(html).toContain('>Sherina<');
    expect(html).toContain('@sherina');
    // The username is secondary metadata and appears exactly once.
    expect(occurrences(html, 'sherina')).toBe(1);
  });

  it('keeps a real display name and shows the username beside it', () => {
    const html = renderCard(account({ username: 'gabrielle', displayName: 'Gab' }), [
      connection('Northwind'),
    ]);

    expect(html).toContain('>Gab<');
    expect(html).toContain('@gabrielle');
    expect(occurrences(html, 'gabrielle')).toBe(1);
  });

  it('names the sandbox chip after the connection, so it cannot read as a second name', () => {
    const html = renderCard(
      account({
        username: 'sherina',
        displayName: 'sherina',
        assignments: [
          {
            id: 'a-1',
            profileId: 'p-1',
            source: 'northwind',
            sandbox: 'sherina_sandbox',
            includeData: true,
            createdAt: '2026-01-16T08:30:00.000Z',
          },
        ],
      }),
      [connection('Sherina')],
    );

    expect(html).toContain('Connection · Sherina');
  });
});
