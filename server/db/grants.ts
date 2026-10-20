import type { GrantSqlRequest, GrantSqlResult } from '../../shared/types';
import { AppError } from '../errors';

const PRIVILEGES = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'INDEX',
  'REFERENCES',
  'EXECUTE',
  'SHOW VIEW',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
]);

const USER_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
const HOST_PATTERN = /^[A-Za-z0-9_.:%-]{1,255}$/;
const DATABASE_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``;
}

export function generateGrantSql(input: GrantSqlRequest): GrantSqlResult {
  const user = input.user?.trim();
  const host = input.host?.trim() || 'localhost';
  if (!user || !USER_PATTERN.test(user)) {
    throw new AppError(
      'VALIDATION',
      'User name may contain letters, digits, underscore, dot, and hyphen only.',
    );
  }
  if (!HOST_PATTERN.test(host)) {
    throw new AppError('VALIDATION', 'Host contains unsupported characters.');
  }
  const databases = Array.from(
    new Set((input.databases ?? []).map((database) => database.trim()).filter(Boolean)),
  );
  if (databases.length === 0) {
    throw new AppError('VALIDATION', 'Select at least one database for the grant.');
  }
  for (const database of databases) {
    if (database !== '*' && !DATABASE_PATTERN.test(database)) {
      throw new AppError('VALIDATION', `Invalid database name: ${database}`);
    }
  }

  const privileges = Array.from(
    new Set(
      (input.privileges && input.privileges.length > 0
        ? input.privileges
        : ['SELECT', 'SHOW VIEW']
      ).map((privilege) => privilege.trim().toUpperCase()),
    ),
  );
  for (const privilege of privileges) {
    if (!PRIVILEGES.has(privilege)) {
      throw new AppError('VALIDATION', `Unsupported privilege: ${privilege}`);
    }
  }

  const lines: string[] = [
    '-- MyLens generated this SQL for review only. It does not execute account changes.',
    `CREATE USER IF NOT EXISTS ${quoteString(user)}@${quoteString(host)} IDENTIFIED BY '<password>';`,
  ];
  for (const database of databases) {
    const scope = database === '*' ? '*.*' : `${quoteIdent(database)}.*`;
    lines.push(
      `GRANT ${privileges.join(', ')} ON ${scope} TO ${quoteString(user)}@${quoteString(host)};`,
    );
  }
  lines.push(
    '-- Replace <password> with a strong secret, then verify the grants with SHOW GRANTS.',
  );

  return {
    sql: lines.join('\n'),
    warnings: [
      'MyLens does not execute this SQL. Run it yourself with an administrative account.',
      'Use a strong password and store it in your connection profile, not in a shell history.',
      'The profile allowlist is a UI guardrail; these MySQL grants are the real boundary.',
    ],
  };
}
