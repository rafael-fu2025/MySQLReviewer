/**
 * User-facing strings shared by more than one screen, so the same action or
 * guarantee never drifts into two wordings. Canonical terms: "statement"
 * (not query), "connection" (not profile), "AI summary", "Run audit".
 */

/** Empty-state hint for screens that need a database chosen in the top bar. */
export const selectDatabaseHint = 'Select a database in the top bar.';

/** Server compatibility line shown on connect-related surfaces. */
export const compatLine = 'MySQL 5.7 · 8.x · MariaDB 10.x';

/** Badge for generated SQL the app did not execute. */
export const notExecutedBadge = 'not executed';

/** Saved-credential failure copy differs only by who can fix the connection. */
export function connectionAccessDeniedMessage(role: 'admin' | 'member' | undefined): string {
  return role === 'member'
    ? 'MyLens could not use this connection’s saved database password. Ask an administrator to edit the connection and save the correct password.'
    : 'MyLens could not use this connection’s saved database password. Edit the connection and save the correct password, then try again.';
}

/** Canonical copy for confirming the deletion of a saved connection. */
export const deleteConnectionTitle = 'Delete connection?';
export const deleteConnectionConfirmLabel = 'Delete connection';
export function deleteConnectionMessage(name: string): string {
  return `Remove "${name}"? Its data on the server is untouched.`;
}
