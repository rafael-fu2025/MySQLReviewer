import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { connectionAccessDeniedMessage } from '../src/lib/copy';
import { ConnectionForm } from '../src/components/ConnectionForm';
import {
  ConnectionStatusPanel,
  ConnectionsSection,
  HeroPanel,
  MachinePanel,
  SafetyModelPanel,
} from '../src/pages/ConnectPage';
import type { ConnectionProfile } from '../shared/types';

/**
 * D-11, D-12, D-13, D-14, D-23, D-24 — Connect page design fixes.
 *
 * The page reads the app store, so the presentational parts are rendered
 * here with plain props and asserted through their static markup.
 */

const profile: ConnectionProfile = {
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

const noop = (): void => {};

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The markup of the first button that carries `label`. */
function buttonMarkup(html: string, label: string): string {
  for (const match of html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) {
    if (match[0].includes(label)) return match[0];
  }
  throw new Error(`no button labelled "${label}"`);
}

/** The markup of the element that carries `text`, from its opening tag. */
function elementMarkup(html: string, text: string): string {
  // The value also appears in the `title` attribute, so the last occurrence
  // is the one inside the element body.
  const index = html.lastIndexOf(text);
  expect(index).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<span', index), index + text.length);
}

function renderHero(connected: boolean): string {
  return render(
    <HeroPanel canManage connected={connected} onNewConnection={noop} onOpenWorkspace={noop} />,
  );
}

function renderStatus(): string {
  return render(
    <ConnectionStatusPanel
      version="10.4.32-MariaDB"
      flavor="mysql"
      onOpenWorkspace={noop}
      onDisconnect={noop}
    />,
  );
}

function renderSection({
  profiles = [profile],
  activeProfileId = null,
  connected = false,
}: {
  profiles?: ConnectionProfile[];
  activeProfileId?: string | null;
  connected?: boolean;
} = {}): string {
  return render(
    <ConnectionsSection
      canManage
      subtitle="A seeded XAMPP connection is ready."
      profiles={profiles}
      activeProfileId={activeProfileId}
      connected={connected}
      connectingId={null}
      testingId={null}
      sandboxesByProfileId={{}}
      error={null}
      onNewConnection={noop}
      onConnect={noop}
      onEdit={noop}
      onDelete={noop}
      onTest={noop}
    />,
  );
}

describe('saved-credential-only connection UX', () => {
  const connectSource = readFileSync(
    new URL('../src/pages/ConnectPage.tsx', import.meta.url),
    'utf8',
  );
  const storeSource = readFileSync(new URL('../src/store/app-store.ts', import.meta.url), 'utf8');
  const formSource = readFileSync(
    new URL('../src/components/ConnectionForm.tsx', import.meta.url),
    'utf8',
  );
  const settingsSource = readFileSync(
    new URL('../src/pages/SettingsPage.tsx', import.meta.url),
    'utf8',
  );

  it('directs admins to edit and save the password after access is denied', () => {
    expect(connectionAccessDeniedMessage('admin')).toContain('Edit the connection');
    expect(connectionAccessDeniedMessage('admin')).toContain('save the correct password');
  });

  it('directs members to ask an administrator after access is denied', () => {
    expect(connectionAccessDeniedMessage('member')).toContain('Ask an administrator');
  });

  it('removes every runtime password override path from the connect page and store', () => {
    expect(connectSource).not.toContain('Password required');
    expect(connectSource).not.toContain('passwordFor');
    expect(connectSource).not.toContain('suppliedPassword');
    expect(connectSource).not.toContain('mylens-session-password');
    expect(storeSource).toContain('connect: (profileId: string) => Promise<void>');
    expect(storeSource).not.toContain('connect: (profileId: string, password');
    expect(storeSource).not.toContain('password !== undefined');
  });

  it('contains no session-password concept anywhere in client source', () => {
    const clientSources = [connectSource, storeSource, formSource, settingsSource].join('\n');
    expect(clientSources.toLowerCase()).not.toContain('session password');
    expect(connectSource).toContain('encrypted saved password');
    expect(settingsSource).toContain('encrypted saved password');
    expect(connectSource).toContain('passwordless connection');
    expect(settingsSource).toContain('passwordless connection');
  });

  it('makes the connection editor explain that entered passwords are encrypted and saved', () => {
    const html = render(
      <ConnectionForm profile={profile} onSaved={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain('encrypted with a local key and saved with the connection');
    expect(html).toContain('Passwordless MySQL accounts can leave this field empty');
    expect(html).not.toContain('Remember password');
    expect(formSource).toContain('rememberPassword: true');
  });
});

describe('D-11 — the hero card must size to its content', () => {
  it('does not stretch the hero card to the height of the panel next to it', () => {
    const html = renderHero(false);
    const hero = html.match(/class="([^"]*hero-panel[^"]*)"/);
    expect(hero).not.toBeNull();
    // `self-start` keeps the card at its content height; without it the grid
    // row stretched the card and left ~295px of empty space below the buttons.
    expect(hero?.[1]).toContain('self-start');
  });

  it('does not give the hero card a fixed minimum height', () => {
    const html = renderHero(false);
    const hero = html.match(/class="([^"]*hero-panel[^"]*)"/);
    expect(hero?.[1]).not.toMatch(/min-h-/);
  });
});

describe('D-12 — one primary action on the page', () => {
  it('keeps a single primary button when a connection is live', () => {
    const html = [
      renderHero(true),
      renderStatus(),
      renderSection({ activeProfileId: profile.id, connected: true }),
    ].join('');
    expect(countOf(html, 'button-primary')).toBe(1);
  });

  it('puts the primary emphasis on the open-workspace action', () => {
    const html = [
      renderHero(true),
      renderStatus(),
      renderSection({ activeProfileId: profile.id, connected: true }),
    ].join('');
    expect(buttonMarkup(html, 'Open workspace')).toContain('button-primary');
  });

  it('never styles "New connection" as a primary action', () => {
    const html = [
      renderHero(true),
      renderStatus(),
      renderSection({ activeProfileId: profile.id, connected: true }),
    ].join('');
    expect(buttonMarkup(html, 'New connection')).not.toContain('button-primary');
  });

  it('never styles the card reconnect action as a primary action', () => {
    const html = [
      renderHero(true),
      renderStatus(),
      renderSection({ activeProfileId: profile.id, connected: true }),
    ].join('');
    expect(buttonMarkup(html, 'Reconnect')).not.toContain('button-primary');
  });

  it('gives the connect action the primary slot while nothing is connected', () => {
    const html = [renderHero(false), renderSection({ connected: false })].join('');
    expect(countOf(html, 'button-primary')).toBe(1);
    expect(buttonMarkup(html, 'Connect')).toContain('button-primary');
  });

  it('reserves the primary slot for a single connection before one is live', () => {
    const profiles = [profile, { ...profile, id: 'profile-2', name: 'Second' }];
    // Before a connection is live the connect action of the default
    // connection holds the page's only primary slot.
    expect(countOf(renderSection({ profiles, connected: false }), 'button-primary')).toBe(1);
    // Once one is live the slot belongs to "Open workspace" and no card
    // competes for it.
    expect(countOf(renderSection({ profiles, connected: true }), 'button-primary')).toBe(0);
  });
});

describe('D-13 — "New connection" is offered once, not three times', () => {
  it('offers "New connection" at most twice on the page', () => {
    const html = renderHero(false) + renderSection();
    expect(countOf(html, 'New connection')).toBeLessThanOrEqual(2);
  });

  it('does not render a dashed "New connection" tile in the connection grid', () => {
    expect(renderSection()).not.toContain('border-dashed');
  });
});

describe('D-14 — long paths stay readable', () => {
  it('truncates the XAMPP path with an ellipsis and keeps the full value in a title', () => {
    const xamppPath = 'C:\\Users\\udtoh_lmtzs7k\\MySQL-8.0.35-winx64';
    const html = render(
      <MachinePanel
        xamppPath={xamppPath}
        xamppPort={3306}
        nodeVersion="v22.1.0"
        dataDir="C:\\Users\\udtoh_lmtzs7k\\MySQLReviewer\\data"
      />,
    );
    const tag = elementMarkup(html, xamppPath);
    expect(tag).toContain('truncate');
    expect(tag).toContain(`title="${xamppPath}"`);
  });

  it('keeps the data directory readable too', () => {
    const dataDir = 'C:\\Users\\udtoh_lmtzs7k\\MySQLReviewer\\data';
    const html = render(
      <MachinePanel xamppPath={null} xamppPort={null} nodeVersion="v22.1.0" dataDir={dataDir} />,
    );
    const tag = elementMarkup(html, dataDir);
    expect(tag).toContain('truncate');
    expect(tag).toContain(`title="${dataDir}"`);
  });
});

describe('D-23 — the safety model is scannable', () => {
  it('states the safety model as short bullets', () => {
    const html = render(<SafetyModelPanel />);
    expect(countOf(html, '<li')).toBe(4);
  });

  it('keeps every fact the old paragraph carried', () => {
    const html = render(<SafetyModelPanel />);
    expect(html).toContain('127.0.0.1');
    expect(html).toContain('Host/Origin');
    expect(html).toContain('per-boot token');
    expect(html).toContain('AES-256-GCM');
    expect(html).toContain('review action');
  });

  it('no longer renders the safety model as one prose paragraph', () => {
    const html = render(<SafetyModelPanel />);
    expect(html).not.toContain('The API binds to 127.0.0.1, validates the Host/Origin');
  });
});

describe('D-24 — machine, security and connection state are separate panels', () => {
  it('gives each concern its own card', () => {
    const machine = render(
      <MachinePanel
        xamppPath="C:\\xampp"
        xamppPort={3306}
        nodeVersion="v22.1.0"
        dataDir="C:\\data"
      />,
    );
    const safety = render(<SafetyModelPanel />);
    const status = renderStatus();
    expect(machine).toContain('class="card');
    expect(safety).toContain('class="card');
    expect(status).toContain('class="card');
  });

  it('titles each panel so the three concerns can be told apart', () => {
    const machine = render(
      <MachinePanel
        xamppPath="C:\\xampp"
        xamppPort={3306}
        nodeVersion="v22.1.0"
        dataDir="C:\\data"
      />,
    );
    expect(machine).toContain('This machine');
    expect(render(<SafetyModelPanel />)).toContain('Safety model');
    expect(renderStatus()).toContain('Connection status');
  });

  it('keeps machine facts out of the security panel', () => {
    const safety = render(<SafetyModelPanel />);
    expect(safety).not.toContain('XAMPP detected');
    expect(safety).not.toContain('Data directory');
  });

  it('keeps the live connection state out of the machine and security panels', () => {
    const status = renderStatus();
    expect(status).not.toContain('XAMPP detected');
    expect(status).not.toContain('AES-256-GCM');
  });
});
