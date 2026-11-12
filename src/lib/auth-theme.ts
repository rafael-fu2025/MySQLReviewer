import type { ThemePreference } from '@shared/types';

/**
 * The sign-in screen's theme toggle is a browser-level preference: before any
 * account signs in there is no user to persist a server-side theme for, so the
 * choice lives in localStorage under the `mylens.*` key convention. Storage is
 * passed in rather than read from the global so tests can inject a stub.
 */
export const AUTH_THEME_STORAGE_KEY = 'mylens.authTheme';

export type AuthTheme = Exclude<ThemePreference, 'system'>;

export function readAuthTheme(storage: Pick<Storage, 'getItem'> | null): AuthTheme | null {
  try {
    const stored = storage?.getItem(AUTH_THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // Storage unavailable (private mode, blocked by policy): use the default.
    return null;
  }
}

export function writeAuthTheme(storage: Pick<Storage, 'setItem'> | null, theme: AuthTheme): void {
  try {
    storage?.setItem(AUTH_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the choice still applies for this visit.
  }
}

/** The toggle only ever flips between the two concrete themes. */
export function flipAuthTheme(theme: AuthTheme): AuthTheme {
  return theme === 'dark' ? 'light' : 'dark';
}
