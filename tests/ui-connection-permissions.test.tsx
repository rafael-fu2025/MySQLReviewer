import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionForm } from '../src/components/ConnectionForm';
import type { ConnectionProfile } from '../shared/types';

/**
 * D-01 — the per-connection write lock was unreachable in the UI.
 *
 * The permission checkboxes were rendered inside the
 * `{form.databaseScope === 'selected' ? (...) : null}` branch of the
 * connection form, next to the database picker, so a connection with the
 * default "all databases" scope could never show them.
 */

const baseProfile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Rafael',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  database: 'northwind',
  socketPath: null,
  ssl: null,
  rememberPassword: false,
  hasPassword: false,
  passwordSource: 'none',
  color: null,
  databaseScope: 'all',
  allowedDatabases: [],
  allowServerWideInsights: true,
  writeAccess: 'full',
  createdAt: '2026-10-24T10:29:00.000Z',
  updatedAt: '2026-10-24T10:29:00.000Z',
};

function render(profile: ConnectionProfile): string {
  return renderToStaticMarkup(
    <ConnectionForm profile={profile} onSaved={() => {}} onCancel={() => {}} />,
  );
}

describe('connection permission controls', () => {
  it('offers the per-connection write lock on an all-databases connection', () => {
    expect(render(baseProfile)).toContain('Allow members to write through this connection');
  });

  it('offers the server-wide insights control on an all-databases connection', () => {
    expect(render(baseProfile)).toContain('Allow server-wide performance and security insights');
  });

  it('still offers the write lock on a connection limited to selected databases', () => {
    const scoped: ConnectionProfile = {
      ...baseProfile,
      databaseScope: 'selected',
      allowedDatabases: ['northwind'],
    };
    expect(render(scoped)).toContain('Allow members to write through this connection');
  });

  it('keeps the write-lock control usable on an all-databases connection', () => {
    const html = render(baseProfile);
    // The control must not be disabled: the write lock applies whatever the
    // database scope is.
    const labelIndex = html.indexOf('Allow members to write through this connection');
    expect(labelIndex).toBeGreaterThan(-1);
    const inputIndex = html.lastIndexOf('type="checkbox"', labelIndex);
    expect(inputIndex).toBeGreaterThan(-1);
    expect(html.slice(inputIndex, labelIndex)).not.toContain('disabled');
  });

  it('marks the insights control unavailable while the scope is narrowed', () => {
    const scoped: ConnectionProfile = {
      ...baseProfile,
      databaseScope: 'selected',
      allowedDatabases: ['northwind'],
    };
    const html = render(scoped);
    const labelIndex = html.indexOf('Allow server-wide performance and security insights');
    expect(labelIndex).toBeGreaterThan(-1);
    const inputIndex = html.lastIndexOf('type="checkbox"', labelIndex);
    expect(html.slice(inputIndex, labelIndex)).toContain('disabled');
  });
});
