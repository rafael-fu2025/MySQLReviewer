import sqlParser from 'node-sql-parser';
import type { ConnectionProfile, DatabaseInfo } from '../../shared/types';
import { SYSTEM_SCHEMAS } from '../../shared/types';
import { AppError } from '../errors';
import { getStoredProfile } from '../store/profiles';
import {
  significantTokens,
  splitStatements,
  tokenUpper,
  type Token,
} from '../review/tokenizer';

const parserModule = sqlParser as unknown as typeof import('node-sql-parser');
const parser = new parserModule.Parser();

export interface DatabaseScope {
  mode: 'all' | 'selected';
  allowed: Set<string>;
  serverWideInsights: boolean;
}

export async function getDatabaseScope(profileId: string): Promise<DatabaseScope> {
  const profile = await getStoredProfile(profileId);
  return {
    mode: profile.databaseScope === 'selected' ? 'selected' : 'all',
    allowed: new Set(profile.allowedDatabases ?? []),
    serverWideInsights: profile.allowServerWideInsights !== false,
  };
}

export function filterDatabasesByScope(
  databases: DatabaseInfo[],
  scope: DatabaseScope,
): DatabaseInfo[] {
  if (scope.mode === 'all') return databases;
  return databases.filter((database) => scope.allowed.has(database.name));
}

export async function assertDatabaseAllowed(
  profileId: string,
  database: string | null | undefined,
): Promise<DatabaseScope> {
  const scope = await getDatabaseScope(profileId);
  if (scope.mode === 'all') return scope;
  if (!database) return scope;
  if (!scope.allowed.has(database)) {
    throw new AppError(
      'DATABASE_NOT_ALLOWED',
      `This connection is restricted and cannot access the database "${database}".`,
      403,
      { database, allowedDatabases: Array.from(scope.allowed) },
    );
  }
  return scope;
}

export async function assertServerWideAllowed(profileId: string): Promise<DatabaseScope> {
  const scope = await getDatabaseScope(profileId);
  if (scope.mode === 'selected' && !scope.serverWideInsights) {
    throw new AppError(
      'SERVER_WIDE_INSIGHTS_DISABLED',
      'Server-wide insights are disabled for this scoped connection. Enable them in the connection settings if needed.',
      403,
    );
  }
  return scope;
}

function collectFromValue(value: unknown, out: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.db === 'string' && record.db) out.add(record.db);
  }
}

function walkAst(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  collectFromValue(record.from, out);
  collectFromValue(record.table, out);
  if (record.type === 'column_ref' && typeof record.db === 'string' && record.db) {
    out.add(record.db);
  }
  for (const value of Object.values(record)) walkAst(value, out);
}

function tokenWordAt(tokens: Token[], index: number): Token | null {
  const token = tokens[index];
  return token && token.kind === 'word' ? token : null;
}

function collectShowRefs(tokens: Token[], out: Set<string>): void {
  const first = tokens.find((token) => token.kind !== 'comment');
  if (!first || tokenUpper(first) !== 'SHOW') return;

  if (tokens.some((token) => token.kind === 'word' && tokenUpper(token) === 'DATABASES')) {
    out.add('__all_databases__');
    return;
  }
  if (tokens.some((token) => token.kind === 'word' && tokenUpper(token) === 'PROCESSLIST')) {
    out.add('__processlist__');
    return;
  }

  const second = tokens.find(
    (token, index) => index > tokens.indexOf(first) && token.kind === 'word',
  );
  const showType = second ? tokenUpper(second) : '';

  if (showType === 'GRANTS') {
    out.add('__grants__');
  }
  if (
    showType === 'CREATE' &&
    tokens.some((token) => token.kind === 'word' && tokenUpper(token) === 'USER')
  ) {
    out.add('__accounts__');
  }

  const fromIndex = tokens.findIndex(
    (token) =>
      token.kind === 'word' &&
      (tokenUpper(token) === 'FROM' || tokenUpper(token) === 'IN'),
  );

  if (fromIndex >= 0) {
    const next = tokenWordAt(tokens, fromIndex + 1);
    if (next) {
      const after = tokens[fromIndex + 2];
      if (after?.value === '.') {
        out.add(next.value);
      } else if (showType === 'TABLES' || showType === 'TABLE') {
        out.add(next.value);
      }
    }
  }

  if (
    ['CREATE', 'COLUMNS', 'FIELDS', 'INDEX', 'INDEXES', 'KEYS', 'TRIGGERS', 'EVENTS'].includes(showType)
  ) {
    for (let i = 0; i < tokens.length - 2; i += 1) {
      if (
        tokens[i].kind === 'word' &&
        tokens[i + 1].value === '.' &&
        tokens[i + 2].kind === 'word'
      ) {
        out.add(tokens[i].value);
      }
    }
  }
}

export function collectReferencedDatabases(sql: string): Set<string> {
  const out = new Set<string>();
  for (const statement of splitStatements(sql)) {
    const tokens = significantTokens(statement.tokens);
    try {
      const ast = parser.astify(statement.sql, { database: 'MySQL' });
      const nodes = Array.isArray(ast) ? ast : [ast];
      for (const node of nodes) walkAst(node, out);
    } catch {
      // Fall back to the SHOW/qualified-token checks below.
    }
    collectShowRefs(tokens, out);
  }
  return out;
}

export async function assertSqlScope(
  profileId: string,
  sql: string,
  database: string | null | undefined,
): Promise<DatabaseScope> {
  const scope = await getDatabaseScope(profileId);
  if (scope.mode === 'all') return scope;

  if (database && !scope.allowed.has(database)) {
    throw new AppError(
      'DATABASE_NOT_ALLOWED',
      `This connection is restricted and cannot access the database "${database}".`,
      403,
      { database, allowedDatabases: Array.from(scope.allowed) },
    );
  }

  const tokens = significantTokens(splitStatements(sql).flatMap((part) => part.tokens));
  if (tokens.some((token) => token.kind === 'word' && tokenUpper(token) === 'USE')) {
    throw new AppError(
      'DATABASE_NOT_ALLOWED',
      'USE is not allowed on a scoped connection. Choose an allowed database instead.',
      403,
    );
  }

  const refs = collectReferencedDatabases(sql);
  if (refs.has('__all_databases__')) {
    throw new AppError(
      'DATABASE_NOT_ALLOWED',
      'SHOW DATABASES is blocked on a scoped connection because it reveals other databases.',
      403,
    );
  }
  if (refs.has('__processlist__')) {
    throw new AppError(
      'DATABASE_NOT_ALLOWED',
      'SHOW PROCESSLIST is blocked on a scoped connection because it can reveal other databases.',
      403,
    );
  }
  if (refs.has('__grants__') || refs.has('__accounts__')) {
    throw new AppError(
      'DATABASE_NOT_ALLOWED',
      'Account metadata is blocked on a scoped connection because it can reveal access to other databases.',
      403,
    );
  }

  for (const reference of refs) {
    if (SYSTEM_SCHEMAS.includes(reference) || !scope.allowed.has(reference)) {
      throw new AppError(
        'DATABASE_NOT_ALLOWED',
        `This connection is restricted and the statement references the database "${reference}".`,
        403,
        { database: reference, allowedDatabases: Array.from(scope.allowed) },
      );
    }
  }

  return scope;
}

export function profileScopeSummary(profile: ConnectionProfile): string {
  if (profile.databaseScope !== 'selected') return 'All databases';
  return `${profile.allowedDatabases.length} database${profile.allowedDatabases.length === 1 ? '' : 's'}`;
}
