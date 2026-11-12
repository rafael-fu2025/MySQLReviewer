import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from '../src/pages/LoginPage';
import {
  AUTH_THEME_STORAGE_KEY,
  flipAuthTheme,
  readAuthTheme,
  writeAuthTheme,
} from '../src/lib/auth-theme';

/**
 * D1 — the login page redesign: a concrete headline, the real product shown
 * as a framed screenshot, and no filler badges.
 *
 * Static render through react-dom/server, like the other UI tests. The page
 * needs a router context for its navigate/location hooks, so it renders
 * inside a MemoryRouter. The observatory's three.js scene is lazy-loaded and
 * purely decorative, so its chunk is mocked out — static markup must not
 * need WebGL.
 */

vi.mock('../src/components/observatory-atom-scene', () => ({ default: () => null }));

function renderLogin(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/login']}>
      <LoginPage mode="login" />
    </MemoryRouter>,
  );
}

describe('login page hero (D1)', () => {
  it('renders the sign-in heading', () => {
    const html = renderLogin();
    expect(html).toContain('Welcome back.');
  });

  it('states the eyebrow as what the product is, not a mood', () => {
    expect(renderLogin()).toContain('MySQL review studio · local-first');
  });

  it('names concrete features in the hero sub', () => {
    const html = renderLogin();
    expect(html).toContain('Explore schemas');
    expect(html).toContain('read EXPLAIN plans');
    expect(html).toContain('SQL Lab');
  });

  it('shows the workspace screenshot with a describing alt', () => {
    const html = renderLogin();
    expect(html).toContain('<img');
    expect(html).toContain(
      'alt="The MyLens workspace: schema tree, SQL editor, results grid, and AI assistant"',
    );
  });

  it('keeps the hero free of italic emphasis', () => {
    expect(renderLogin()).not.toContain('<em');
  });
});

describe('login page filler removal (D1)', () => {
  it('drops the numbered chips', () => {
    const html = renderLogin();
    expect(html).not.toContain('01 Explore');
    expect(html).not.toContain('02 Understand');
    expect(html).not.toContain('03 Refine');
  });

  it('drops the scene foot', () => {
    const html = renderLogin();
    expect(html).not.toContain('OBSERVE');
    expect(html).not.toContain('UNDERSTAND');
    expect(html).not.toContain('IMPROVE');
  });

  it('drops the observatory note', () => {
    expect(renderLogin()).not.toContain('Less noise. More knowing.');
  });
});

describe('auth theme toggle', () => {
  it('renders as a labeled button defaulting to dark', () => {
    const html = renderLogin();
    expect(html).toContain('auth-theme-toggle');
    expect(html).toContain('aria-label="Switch to light theme"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('sits inside the auth panel, ahead of the heading markup', () => {
    const html = renderLogin();
    const toggle = html.indexOf('auth-theme-toggle');
    const heading = html.indexOf('auth-heading');
    expect(toggle).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(toggle);
  });

  it('flips the advertised action between themes', () => {
    expect(flipAuthTheme('dark')).toBe('light');
    expect(flipAuthTheme('light')).toBe('dark');
  });
});

describe('auth theme storage helpers', () => {
  function stubStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  }

  it('falls back to null when nothing (or junk) is stored', () => {
    expect(readAuthTheme(stubStorage())).toBeNull();
    expect(readAuthTheme(stubStorage({ [AUTH_THEME_STORAGE_KEY]: 'sepia' }))).toBeNull();
  });

  it('round-trips a light/dark choice under the mylens key', () => {
    const storage = stubStorage();
    writeAuthTheme(storage, 'light');
    expect(readAuthTheme(storage)).toBe('light');
    writeAuthTheme(storage, 'dark');
    expect(readAuthTheme(storage)).toBe('dark');
  });

  it('treats an unavailable store as a no-op, not a crash', () => {
    expect(() => writeAuthTheme(null, 'light')).not.toThrow();
    expect(readAuthTheme(null)).toBeNull();
  });
});
