import sqlParser from 'node-sql-parser';
import type { ConnectionProfile, DatabaseInfo } from '../../shared/types';
import { SYSTEM_SCHEMAS } from '../../shared/types';
import { AppError } from '../errors';
import { getStoredProfile } from '../store/profiles';
import {
  significantTokens,
  splitStatements,
  tokenize,
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

/**
 * `override` narrows a member to their sandbox databases: mode becomes
 * `selected`, server-wide insights are off, and only the listed databases
 * pass. Admins pass nothing and keep the profile's own scope.
 */
export async function getDatabaseScope(
  profileId: string,
  override?: { allowed: string[] },
): Promise<DatabaseScope> {
  if (override) {
    return {
      mode: 'selected',
      allowed: new Set(override.allowed),
      serverWideInsights: false,
    };
  }
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
  override?: { allowed: string[] },
): Promise<DatabaseScope> {
  const scope = await getDatabaseScope(profileId, override);
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

export async function assertServerWideAllowed(
  profileId: string,
  override?: { allowed: string[] },
): Promise<DatabaseScope> {
  const scope = await getDatabaseScope(profileId, override);
  if (scope.mode === 'selected' && !scope.serverWideInsights) {
    throw new AppError(
      'SERVER_WIDE_INSIGHTS_DISABLED',
      'Server-wide insights are disabled for this scoped connection. Enable them in the connection settings if needed.',
      403,
    );
  }
  return scope;
}

/** Minimal processlist shape needed to decide whether a session is in scope. */
export interface ProcessScopeTarget {
  id: number;
  db: string | null;
}

export function isProcessInScope(process: ProcessScopeTarget, scope: DatabaseScope): boolean {
  if (scope.mode === 'all') return true;
  return process.db != null && scope.allowed.has(process.db);
}

/**
 * Kill targets must exist in the current processlist, and on a scoped
 * connection they must be attached to an allowed database. A session without a
 * database cannot be verified, so it is treated as out of scope.
 */
export function assertProcessInScope(
  processId: number,
  processlist: readonly ProcessScopeTarget[],
  scope: DatabaseScope,
): ProcessScopeTarget {
  const target = processlist.find((process) => process.id === processId);
  if (!target) {
    throw new AppError(
      'PROCESS_NOT_FOUND',
      `No session with id ${processId} is visible on this server.`,
      400,
      { processId },
    );
  }
  if (!isProcessInScope(target, scope)) {
    throw new AppError(
      'PROCESS_NOT_ALLOWED',
      `Session ${processId} is not using a database in this connection’s allowed scope.`,
      403,
      {
        processId,
        database: target.db,
        allowedDatabases: Array.from(scope.allowed),
      },
    );
  }
  return target;
}

/**
 * Collect the database references of a parsed statement.
 *
 * Every node that carries an explicit database qualifier (`from[]`, `table`,
 * `name[]`, `lock.tables[]`, `column_ref.db`, …) is picked up by the generic
 * sweep. The statement types whose database name is *not* stored in a `db`
 * property (`DROP DATABASE`, `CREATE DATABASE`, `CALL db.p()`, `GRANT … ON
 * db.*`) are handled explicitly.
 */
function collectAstRefs(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectAstRefs(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const keyword = typeof record.keyword === 'string' ? record.keyword.toUpperCase() : '';

  // Any node that carries an explicit database qualifier.
  if (typeof record.db === 'string' && record.db) out.add(record.db);

  if (type === 'create' && (keyword === 'DATABASE' || keyword === 'SCHEMA')) {
    // `CREATE DATABASE db` → { database: { schema: [ { value: 'db' } ] } }
    const database = record.database as Record<string, unknown> | undefined;
    const entries = database && Array.isArray(database.schema) ? database.schema : [];
    for (const entry of entries) {
      const value = (entry as Record<string, unknown> | undefined)?.value;
      if (typeof value === 'string' && value) out.add(value);
    }
  } else if (
    (type === 'drop' || type === 'truncate') &&
    (keyword === 'DATABASE' || keyword === 'SCHEMA') &&
    typeof record.name === 'string' &&
    record.name
  ) {
    // `DROP DATABASE db` → { name: 'db' }
    out.add(record.name);
  } else if (type === 'call') {
    // `CALL db.p()` → { expr: { name: { schema: { value: 'db' } } } }
    const expr = record.expr as Record<string, unknown> | undefined;
    const name = expr && (expr.name as Record<string, unknown> | undefined);
    const schema = name && (name.schema as Record<string, unknown> | undefined);
    if (schema && typeof schema.value === 'string' && schema.value) out.add(schema.value);
  } else if (type === 'grant') {
    // `GRANT SELECT ON db.* TO user` → { on: { priv_level: [ { prefix: 'db' } ] } }
    const on = record.on as Record<string, unknown> | undefined;
    const levels = on && Array.isArray(on.priv_level) ? on.priv_level : [];
    for (const level of levels) {
      const prefix = (level as Record<string, unknown> | undefined)?.prefix;
      if (typeof prefix === 'string' && prefix) out.add(prefix);
    }
  }

  for (const value of Object.values(record)) collectAstRefs(value, out);
}

function tokenWordAt(tokens: Token[], index: number): Token | null {
  const token = tokens[index];
  return token && token.kind === 'word' ? token : null;
}

/** SHOW variants whose `FROM <name>` names a database, not a table. */
const DATABASE_NAMING_SHOW_TYPES = new Set([
  'TABLES',
  'TABLE',
  'TRIGGERS',
  'EVENTS',
  'PROCEDURE',
  'FUNCTION',
]);

/** SHOW variants whose `FROM <table> FROM <db>` names the database second. */
const TABLE_NAMING_SHOW_TYPES = new Set(['COLUMNS', 'FIELDS', 'INDEX', 'INDEXES', 'KEYS']);

/** Every SHOW variant the token scanner understands. */
const KNOWN_SHOW_TYPES = new Set([
  ...DATABASE_NAMING_SHOW_TYPES,
  ...TABLE_NAMING_SHOW_TYPES,
  'DATABASES',
  'SCHEMAS',
  'PRIMARY',
  'GRANTS',
  'PROCESSLIST',
  'STATUS',
  'VARIABLES',
  'CREATE',
  'VIEW',
  'WARNINGS',
  'ERRORS',
  'ENGINES',
  'PLUGINS',
  'CHARSET',
  'CHARACTER',
  'COLLATION',
  'STORAGE',
  'MASTER',
  'SLAVE',
  'REPLICA',
  'BINLOG',
  'OPEN',
  'COUNT',
]);

/** SHOW variants whose target may be qualified with a database name. */
const QUALIFIED_SHOW_TYPES = new Set([
  ...TABLE_NAMING_SHOW_TYPES,
  'CREATE',
  'TRIGGERS',
  'EVENTS',
  'TABLE',
  'TABLES',
  'VIEW',
  'PROCEDURE',
  'FUNCTION',
]);

/**
 * MySQL and MariaDB execute version comments: the server strips the wrapper and
 * runs the contents, while the tokenizer throws the comment away and the SQL
 * parser never sees it. A statement that uses one can therefore name a database
 * the scope checker cannot see.
 *
 * MySQL uses `/*! … *\/`, MariaDB adds `/*M! … *\/`. `/* !` and `/**!` are
 * ordinary comments for the server and are not flagged.
 */
const EXECUTABLE_COMMENT = /^\/\*(?:[mM]!|!)/;

export function containsExecutableComment(sql: string): boolean {
  return tokenize(sql).some(
    (token) => token.kind === 'comment' && EXECUTABLE_COMMENT.test(token.raw),
  );
}

/**
 * Read a dotted identifier chain (`a`, `a.b`, `a.b.c`) starting at `start`.
 * Backtick-quoted identifiers that the tokenizer split into several words are
 * joined back together, so `` `se`cret` `` is read as one identifier. A
 * backtick-quoted dot (`` `.` ``) also separates the parts of a chain.
 */
function readIdentifierChain(tokens: Token[], start: number): { parts: string[]; next: number } {
  const parts: string[] = [];
  const first = tokens[start];
  if (!first || first.kind !== 'word') return { parts, next: start };

  parts.push(first.value);
  let index = mergeAdjacentWords(tokens, parts, start + 1);

  while (index + 1 < tokens.length && isChainSeparator(tokens[index])) {
    if (tokens[index + 1].kind !== 'word') break;
    index += 1;
    parts.push(tokens[index].value);
    index = mergeAdjacentWords(tokens, parts, index + 1);
  }

  return { parts, next: index };
}

/** A `.` that separates the parts of a qualified name. */
function isChainSeparator(token: Token | undefined): boolean {
  if (!token) return false;
  if (token.kind === 'punct') return token.value === '.';
  return token.kind === 'word' && token.quoted && token.value === '.';
}

/** Join words that sit directly next to each other into one identifier. */
function mergeAdjacentWords(tokens: Token[], parts: string[], index: number): number {
  let cursor = index;
  while (
    cursor < tokens.length &&
    tokens[cursor].kind === 'word' &&
    !isChainSeparator(tokens[cursor]) &&
    tokens[cursor - 1] &&
    tokens[cursor].start === tokens[cursor - 1].end
  ) {
    parts[parts.length - 1] += tokens[cursor].value;
    cursor += 1;
  }
  return cursor;
}

/**
 * What the next identifier of a statement names.
 *
 * - `table`: a table reference, which may be qualified with a database
 *   (`db.table`).
 * - `object`: a schema object (view, trigger, procedure, …), which may be
 *   qualified with a database.
 * - `database`: a database name on its own.
 */
type ReferencePosition = 'none' | 'table' | 'object' | 'database';

/** Schema objects whose name may be qualified with a database name. */
const OBJECT_KEYWORDS = new Set([
  'VIEW',
  'INDEX',
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'EVENT',
  'SEQUENCE',
]);

/** Object keywords of a CREATE/DROP/ALTER/RENAME statement. */
const OBJECT_STATEMENT_KEYWORDS = new Set([...OBJECT_KEYWORDS, 'TABLE', 'DATABASE', 'SCHEMA']);

/** Statements whose object keyword may carry a database qualifier. */
const OBJECT_STATEMENT_LEADS = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME']);

/**
 * Statements that carry their SQL in a string. The scanner cannot read it, so
 * the statement cannot be verified.
 */
const OPAQUE_SQL_STATEMENTS = new Set(['PREPARE', 'EXECUTE']);

interface RawScanContext {
  /** The leading keyword of the statement (`SELECT`, `DROP`, …). */
  lead: string;
  /** The object keyword of a CREATE/DROP/ALTER/RENAME statement. */
  object: string;
}

/**
 * The position a keyword introduces, or `none` when the keyword does not name
 * a database or a table.
 */
function referencePosition(context: RawScanContext, word: string): ReferencePosition {
  switch (word) {
    case 'FROM':
    case 'JOIN':
    case 'TABLE':
    case 'TABLES':
    case 'REFERENCES':
    case 'USING':
    case 'LIKE':
      return 'table';
    case 'INTO':
      // `INSERT INTO db.t`, `REPLACE INTO db.t`.
      return context.lead === 'INSERT' || context.lead === 'REPLACE' ? 'table' : 'none';
    case 'UPDATE':
      // `UPDATE db.t SET …`. The `UPDATE` of `ON DUPLICATE KEY UPDATE` is an
      // assignment, not a table reference.
      return context.lead === 'UPDATE' || context.lead === 'DELETE' ? 'table' : 'none';
    case 'DESCRIBE':
    case 'DESC':
      // `DESCRIBE db.t`. `ORDER BY col DESC` is not a table reference.
      return context.lead === 'DESCRIBE' || context.lead === 'DESC' ? 'table' : 'none';
    case 'HANDLER':
      return context.lead === 'HANDLER' ? 'table' : 'none';
    case 'ON':
      // `CREATE INDEX … ON db.t`, `CREATE TRIGGER … ON db.t`, `GRANT … ON db.*`.
      if (context.lead === 'GRANT' || context.lead === 'REVOKE') return 'database';
      if (
        OBJECT_STATEMENT_LEADS.has(context.lead) &&
        (context.object === 'INDEX' || context.object === 'TRIGGER')
      ) {
        return 'table';
      }
      return 'none';
    case 'TO':
      // `RENAME TABLE a TO b`, `ALTER TABLE a RENAME TO b`, `RENAME DATABASE a TO b`.
      if (context.lead === 'RENAME' && context.object === 'TABLE') return 'table';
      if (context.lead === 'ALTER' && context.object === 'TABLE') return 'table';
      if (
        context.lead === 'RENAME' &&
        (context.object === 'DATABASE' || context.object === 'SCHEMA')
      ) {
        return 'database';
      }
      return 'none';
    case 'DATABASE':
    case 'SCHEMA':
      // `CREATE DATABASE db`, `DROP DATABASE db`, `ALTER DATABASE db`.
      return OBJECT_STATEMENT_LEADS.has(context.lead) ? 'database' : 'none';
    case 'CALL':
      // `CALL db.p()`.
      return context.lead === 'CALL' ? 'object' : 'none';
    case 'USE':
      return context.lead === 'USE' ? 'database' : 'none';
    default:
      break;
  }
  if (OBJECT_KEYWORDS.has(word) && OBJECT_STATEMENT_LEADS.has(context.lead)) return 'object';
  return 'none';
}

export interface RawReferenceScan {
  /** The database names the scanner found. */
  refs: Set<string>;
  /**
   * The statement names a database the scanner could not resolve, so its
   * database references are unknown.
   */
  unresolved: boolean;
}

/**
 * Find the database references of a statement in the raw token stream.
 *
 * The SQL parser is the primary source of truth; this is the safety net for
 * statements the parser mis-reads or rejects outright. It therefore reads the
 * positions a database can be named in — not only the table positions of a
 * `SELECT`, but also the object positions of `CREATE`/`DROP`, the database
 * positions of `DROP DATABASE`, the `ON` position of `CREATE INDEX`, the `TO`
 * position of `RENAME TABLE`, and so on.
 */
function scanRawDatabaseReferences(tokens: Token[]): RawReferenceScan {
  const refs = new Set<string>();
  const words = tokens.filter((token) => token.kind === 'word' && !token.quoted);
  const lead = words.length > 0 ? tokenUpper(words[0]) : '';
  const object = OBJECT_STATEMENT_LEADS.has(lead)
    ? (words
        .slice(1)
        .map((word) => tokenUpper(word))
        .find((word) => OBJECT_STATEMENT_KEYWORDS.has(word)) ?? '')
    : '';
  const context: RawScanContext = { lead, object };

  const unresolved = OPAQUE_SQL_STATEMENTS.has(lead);

  let pending: ReferencePosition = 'none';
  let listPosition: ReferencePosition = 'none';
  let expectingQualifier = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.kind === 'punct' && token.value === ',') {
      // A comma continues a list of references (`FROM a, b`, `RENAME a TO b, c TO d`).
      pending = listPosition;
      listPosition = 'none';
      continue;
    }

    if (token.kind !== 'word') {
      if (token.kind === 'punct' && token.value === '(') {
        // `FROM (SELECT …)` and `COUNT(*)`: the parenthesised part is scanned
        // on its own, so the pending position ends here.
        pending = 'none';
        listPosition = 'none';
      }
      continue;
    }

    if (pending !== 'none') {
      const quoted = token.quoted;
      const word = quoted ? '' : tokenUpper(token);
      if (expectingQualifier) {
        if (word === 'NOT' || word === 'EXISTS') continue;
        expectingQualifier = false;
      }
      if (!quoted && word === 'IF') {
        // `CREATE TABLE IF NOT EXISTS db.t`, `DROP TABLE IF EXISTS db.t`.
        expectingQualifier = true;
        continue;
      }
      const chain = readIdentifierChain(tokens, index);
      index = chain.next - 1;
      if (pending === 'database') {
        if (chain.parts.length > 0) refs.add(chain.parts[0]);
      } else if (chain.parts.length >= 2) {
        refs.add(chain.parts[0]);
      }
      listPosition = pending;
      pending = 'none';
      continue;
    }

    if (token.quoted) continue;
    const position = referencePosition(context, tokenUpper(token));
    if (position !== 'none') pending = position;
  }

  return { refs, unresolved };
}

/**
 * Find qualified table references (`db.table`) in the raw token stream.
 *
 * The SQL parser is the primary source of truth; this is the safety net for
 * statements the parser rejects outright (a backtick inside an identifier, for
 * example). Only table positions are inspected, because `a.b` is `database.table`
 * there and `alias.column` everywhere else.
 */
export function collectQualifiedDatabaseReferences(tokens: Token[]): Set<string> {
  return scanRawDatabaseReferences(tokens).refs;
}

/**
 * Collect the database references of a SHOW statement from its tokens.
 *
 * Returns whether the scanner recognised the SHOW form. An unrecognised form
 * cannot be verified, so the caller denies it on a restricted connection.
 */
function collectShowRefs(tokens: Token[], out: Set<string>): boolean {
  const first = tokens.find((token) => token.kind !== 'comment');
  if (!first || first.kind !== 'word' || tokenUpper(first) !== 'SHOW') return false;
  const words = tokens.filter((token) => token.kind === 'word');
  const afterShow = words.slice(1);

  if (
    afterShow.some((word) => tokenUpper(word) === 'DATABASES' || tokenUpper(word) === 'SCHEMAS')
  ) {
    out.add('__all_databases__');
    return true;
  }
  if (afterShow.some((word) => tokenUpper(word) === 'PROCESSLIST')) {
    out.add('__processlist__');
    return true;
  }

  const typeWord = afterShow.find((word) => KNOWN_SHOW_TYPES.has(tokenUpper(word)));
  if (!typeWord) return false;
  const showType = tokenUpper(typeWord);

  if (showType === 'GRANTS') {
    out.add('__grants__');
  }
  if (showType === 'CREATE') {
    const createdIndex = afterShow.findIndex(
      (word) => tokenUpper(word) === 'DATABASE' || tokenUpper(word) === 'SCHEMA',
    );
    if (createdIndex >= 0) {
      const name = afterShow[createdIndex + 1];
      // `SHOW CREATE DATABASE IF NOT EXISTS db` still names the database.
      const named =
        name && (tokenUpper(name) === 'IF' || tokenUpper(name) === 'NOT')
          ? afterShow[createdIndex + 3]
          : name;
      if (named) out.add(named.value);
    }
    if (afterShow.some((word) => tokenUpper(word) === 'USER')) {
      out.add('__accounts__');
    }
  }

  const databaseNaming = afterShow.find((word) => DATABASE_NAMING_SHOW_TYPES.has(tokenUpper(word)));
  const tableNaming = afterShow.find((word) => TABLE_NAMING_SHOW_TYPES.has(tokenUpper(word)));

  const fromPositions: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === 'word' && (tokenUpper(token) === 'FROM' || tokenUpper(token) === 'IN')) {
      fromPositions.push(index);
    }
  });

  fromPositions.forEach((position, order) => {
    const name = tokenWordAt(tokens, position + 1);
    if (!name) return;
    const after = tokens[position + 2];
    if (after?.kind === 'punct' && after.value === '.') {
      // `SHOW COLUMNS FROM db.table`
      out.add(name.value);
      return;
    }
    if (databaseNaming) {
      // `SHOW FULL TABLES FROM db`, `SHOW TRIGGERS FROM db`. Every name of the
      // list after `FROM`/`IN` is a database, so all of them are collected.
      out.add(name.value);
      let cursor = position + 2;
      while (tokens[cursor]?.kind === 'punct' && tokens[cursor].value === ',') {
        const next = tokenWordAt(tokens, cursor + 1);
        if (!next) break;
        out.add(next.value);
        cursor += 2;
      }
      return;
    }
    if (!databaseNaming && tableNaming && order === 1) {
      // `SHOW INDEX FROM table FROM db`
      out.add(name.value);
    }
  });

  if (QUALIFIED_SHOW_TYPES.has(showType)) {
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

  return true;
}

export interface ScopeReferenceScan {
  /** Every database (and pseudo-database) the statements refer to. */
  refs: Set<string>;
  /**
   * Databases that are named inside a comment. The server ignores a comment,
   * so these are not references, but the scope checker refuses them when they
   * are outside the scope: a comment may only make a statement more
   * restricted, never less.
   */
  commentRefs: Set<string>;
  /** At least one statement could not be parsed by the SQL parser. */
  parseFailed: boolean;
  /**
   * At least one statement could not be parsed *and* could not be verified by
   * the token scanner, so its database references are unknown.
   */
  unverified: boolean;
}

/**
 * The text inside a comment token, without the comment markers.
 */
function commentBody(token: Token): string | null {
  const raw = token.raw;
  if (raw.startsWith('/*')) {
    const end = raw.endsWith('*/') ? raw.length - 2 : raw.length;
    return raw.slice(2, end);
  }
  if (raw.startsWith('#')) return raw.slice(1);
  if (raw.startsWith('--')) return raw.slice(2);
  return null;
}

/**
 * Collect the databases that are named inside the comments of a token stream.
 */
function collectCommentRefsFromTokens(tokens: Token[], out: Set<string>): void {
  for (const token of tokens) {
    if (token.kind !== 'comment') continue;
    const body = commentBody(token);
    if (!body) continue;
    const bodyTokens = significantTokens(tokenize(body));
    for (const reference of scanRawDatabaseReferences(bodyTokens).refs) {
      out.add(reference);
    }
  }
}

/**
 * Collect the databases that are named inside a comment.
 *
 * The server ignores a comment, so a database named in one is not a reference
 * the statement makes. The scope checker still refuses such a statement when
 * the database is outside the scope: a comment may only make a statement more
 * restricted, never less. Comment handling is exactly the mechanism the `--`
 * and `/*!` bypasses abused, so a name that only appears in a comment is not
 * trusted.
 */
export function collectCommentDatabaseReferences(sql: string): Set<string> {
  const refs = new Set<string>();
  for (const statement of splitStatements(sql)) {
    collectCommentRefsFromTokens(statement.tokens, refs);
  }
  return refs;
}

/**
 * Collect every database reference of a SQL string.
 *
 * The parser is walked first; the token scanner (SHOW forms and qualified
 * table references) runs as well, so a database reference is still found when
 * the parser silently drops part of the statement.
 */
export function scanReferencedDatabases(sql: string): ScopeReferenceScan {
  const refs = new Set<string>();
  const commentRefs = new Set<string>();
  let parseFailed = false;
  let unverified = false;

  for (const statement of splitStatements(sql)) {
    const tokens = significantTokens(statement.tokens);
    let parsed = true;
    try {
      const ast = parser.astify(statement.sql, { database: 'MySQL' });
      const nodes = Array.isArray(ast) ? ast : [ast];
      for (const node of nodes) collectAstRefs(node, refs);
    } catch {
      parsed = false;
    }
    const showRecognized = collectShowRefs(tokens, refs);
    const raw = scanRawDatabaseReferences(tokens);
    for (const reference of raw.refs) {
      refs.add(reference);
    }
    collectCommentRefsFromTokens(statement.tokens, commentRefs);
    if (raw.unresolved) {
      // The statement hides its SQL in a string, so its database references
      // cannot be read at all.
      unverified = true;
    }
    if (!parsed) {
      parseFailed = true;
      if (!showRecognized && isShowStatement(tokens)) {
        // An unknown SHOW form cannot be verified.
        unverified = true;
      }
    }
  }

  return { refs, commentRefs, parseFailed, unverified };
}

/** Whether a statement is a SHOW statement. */
function isShowStatement(tokens: Token[]): boolean {
  const first = tokens.find((token) => token.kind === 'word');
  return Boolean(first && !first.quoted && tokenUpper(first) === 'SHOW');
}

export function collectReferencedDatabases(sql: string): Set<string> {
  return scanReferencedDatabases(sql).refs;
}

/**
 * Server-level privilege and account management is not a database operation.
 *
 * A member holds a *scoped* connection: the sandbox boundary is the only thing
 * limiting what they can reach. `GRANT ALL ON *.*` names no database, so the
 * database scope cannot catch it - but it would let a member widen their own
 * access beyond the sandbox. These statements are therefore refused outright
 * on a scoped connection.
 */
function isPrivilegeStatement(sql: string): boolean {
  const tokens = significantTokens(tokenize(sql)).filter(
    (token) => token.kind === 'word' || token.kind === 'punct',
  );
  const lead = tokens[0];
  if (!lead || lead.kind !== 'word' || lead.quoted) return false;
  const first = tokenUpper(lead);
  if (first === 'GRANT' || first === 'REVOKE') return true;
  const second = tokens[1];
  const secondWord = second && second.kind === 'word' && !second.quoted ? tokenUpper(second) : '';
  if (
    (first === 'CREATE' || first === 'DROP' || first === 'ALTER' || first === 'RENAME') &&
    secondWord === 'USER'
  ) {
    return true;
  }
  if (first === 'SET' && secondWord === 'PASSWORD') return true;
  return false;
}

export async function assertSqlScope(
  profileId: string,
  sql: string,
  database: string | null | undefined,
  override?: { allowed: string[] },
): Promise<DatabaseScope> {
  const scope = await getDatabaseScope(profileId, override);
  // An unrestricted connection has no scope to protect, so the rules below do
  // not apply to it. `/*!` and `/*M!` are legitimate MySQL/MariaDB syntax and
  // `mysqldump` writes them at the head of every dump.
  if (scope.mode === 'all') return scope;

  // A version comment is executed by the server but is invisible to the parser
  // and to the tokenizer, so it is rejected before anything is parsed.
  if (containsExecutableComment(sql)) {
    throw new AppError(
      'EXECUTABLE_COMMENT_NOT_ALLOWED',
      'MySQL version comments are not allowed. They are executed by the server but cannot be checked.',
      403,
    );
  }

  // Privilege and account management is server-wide, not database-scoped, so
  // the database scope cannot bound it.
  if (isPrivilegeStatement(sql)) {
    throw new AppError(
      'PRIVILEGE_STATEMENT_NOT_ALLOWED',
      'Grant, revoke and account management statements are not allowed on a restricted connection.',
      403,
    );
  }

  if (database && !scope.allowed.has(database)) {
    throw new AppError(
      'DATABASE_NOT_ALLOWED',
      `This connection is restricted and cannot access the database "${database}".`,
      403,
      { database, allowedDatabases: Array.from(scope.allowed) },
    );
  }

  // `USE` is only a statement when it leads one. A column called `use` is not.
  for (const statement of splitStatements(sql)) {
    const first = significantTokens(statement.tokens)[0];
    if (first && first.kind === 'word' && !first.quoted && tokenUpper(first) === 'USE') {
      throw new AppError(
        'DATABASE_NOT_ALLOWED',
        'USE is not allowed on a scoped connection. Choose an allowed database instead.',
        403,
      );
    }
  }

  const scan = scanReferencedDatabases(sql);
  const refs = scan.refs;
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

  // A database that is only named inside a comment is not a reference the
  // server follows, but it is not trusted either: a comment may only make a
  // statement more restricted, never less.
  for (const reference of scan.commentRefs) {
    if (SYSTEM_SCHEMAS.includes(reference) || !scope.allowed.has(reference)) {
      throw new AppError(
        'DATABASE_NOT_ALLOWED',
        `This connection is restricted and the statement mentions the database "${reference}" in a comment.`,
        403,
        { database: reference, allowedDatabases: Array.from(scope.allowed) },
      );
    }
  }

  if (scan.unverified) {
    // The statement could not be parsed and its database references could not
    // be read, so it cannot be proven that it stays inside the scope. A
    // restricted connection fails closed.
    throw new AppError(
      'SQL_PARSE_FAILED',
      'This statement could not be parsed, so its database references cannot be verified on a restricted connection.',
      403,
    );
  }

  return scope;
}

export function profileScopeSummary(profile: ConnectionProfile): string {
  if (profile.databaseScope !== 'selected') return 'All databases';
  return `${profile.allowedDatabases.length} database${profile.allowedDatabases.length === 1 ? '' : 's'}`;
}
