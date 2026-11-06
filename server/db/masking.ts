import sqlParser from 'node-sql-parser';
import type { CellValue, QueryColumn } from '../../shared/types';
import { tokenize, type Token } from '../review/tokenizer';

/* ------------------------------------------------------------------ */
/* Name policy (M-3)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Substring patterns. They catch credential words that are embedded in a name
 * without a separator (`mysecret`, `userPassword`).
 *
 * `token` is deliberately absent from this list: a bare `token` column is
 * common and is not a secret in many schemas, so tokens are only matched
 * through `SENSITIVE_TOKEN_FAMILIES` or the `*_token` rule.
 */
const SENSITIVE_PATTERNS = [
  /(^|_)(password|passwd|pwd)($|_)/i,
  /(^|_)(secret|api_?key|private_?key|authorization)($|_)/i,
  /(^|_)(session_?id|credit_?card|ssn)($|_)/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /api_?key/i,
  /private_?key/i,
  /access_?token/i,
  /refresh_?token/i,
  /auth_?token/i,
  /authorization/i,
  /credit_?card/i,
  /(^|_)ssn($|_)/i,
  /(^|_)cvv($|_)/i,
];

/**
 * Whole-word names that identify personal or credential data. Matched against
 * the normalized form of a column name, so `userEmail`, `user_email` and
 * `USER EMAIL` all match. This is a *minimum* set, not a complete catalogue
 * of PII: a deployment should treat unlisted columns as reviewable too.
 *
 * These words are a secret in every schema, so they match wherever they
 * appear in the name.
 */
const SENSITIVE_TOKENS = new Set([
  // Credentials and secrets.
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'secrets',
  'authorization',
  'credential',
  'credentials',
  'jwt',
  'bearer',
  // Payment cards.
  'card',
  'cardno',
  'pan',
  'cvc',
  'cvv',
  'csc',
  // Government / national identity.
  'ssn',
  'nationalid',
  // Contact details.
  'email',
  'phone',
  'mobile',
  'telephone',
  'dob',
  // One-time and device secrets.
  'otp',
  'mfa',
  // Banking.
  'iban',
]);

/**
 * Compound names that only read as sensitive as a phrase.
 *
 * A compound is matched at the **end** of the column name: the compound has to
 * be the value the column holds. `api_key` and `encryption_key` hold a
 * secret, while `encryption_key_version_id`, `notes_key_version` and
 * `key_ref` only *mention* a key — they are identifiers, and masking them
 * makes a row impossible to join.
 */
const SENSITIVE_COMPOUNDS = [
  // API and encryption keys.
  'api_key',
  'private_key',
  'access_key',
  'encryption_key',
  'enc_key',
  'signing_key',
  'master_key',
  'client_key',
  'app_key',
  'application_key',
  'consumer_key',
  'session_key',
  // One-time codes.
  'pin_code',
  'pin_number',
  'pin_hash',
  'pin_value',
  'security_pin',
  'atm_pin',
  // Telephone, mail and card identifiers.
  'tel_number',
  'tel_no',
  'home_tel',
  'work_tel',
  'mobile_tel',
  'cell_tel',
  'contact_tel',
  'mail_address',
  'mailing_address',
  'mail_addr',
  'contact_mail',
  'cc_number',
  'cc_no',
  'cc_num',
  'cc_code',
  'cc_value',
  'pw_hash',
  'pw_code',
  'pw_value',
  'pw_token',
  'pw_secret',
  'pass_phrase',
  'pass_code',
  'pass_hash',
  'pass_value',
  'pass_token',
  'pass_secret',
  // Identity and payment identifiers.
  'social_security',
  'social_security_number',
  'national_id',
  'card_number',
  'card_no',
  'credit_card',
  'phone_number',
  'mobile_number',
  'telephone_number',
  'birth_date',
  'date_of_birth',
  'account_number',
  'acct_number',
  'routing_number',
  'security_code',
  'verification_code',
  'one_time_code',
  'passport_number',
];

/**
 * Compound names that are matched **anywhere** in the column name.
 *
 * These families are routinely suffixed with an encoding word, so the
 * compound is rarely the last word of the name: `access_token_enc`,
 * `token_hash`, `qr_token_hash`, `device_token_hash`. A content hash such as
 * `commit_hash`, `user_agent_hash` or `row_hash` is not in this list and is
 * therefore not masked.
 */
const SENSITIVE_TOKEN_FAMILIES = [
  // Tokens.
  'api_token',
  'auth_token',
  'access_token',
  'refresh_token',
  'id_token',
  'bearer_token',
  'session_token',
  'oauth_token',
  'csrf_token',
  'xsrf_token',
  'reset_token',
  'magic_token',
  'email_token',
  'one_time_token',
  'two_factor_token',
  'login_token',
  'sms_token',
  'verification_token',
  'push_token',
  'qr_token',
  'remember_token',
  'owner_token',
  // Secret digests.
  'password_hash',
  'pass_hash',
  'passphrase_hash',
  'secret_hash',
  'api_key_hash',
  'access_key_hash',
  'private_key_hash',
  'encryption_key_hash',
  'token_hash',
  'credential_hash',
  'pin_hash',
  'key_hash',
];

/** SQL syntax that is never a column reference. */
const SQL_KEYWORDS = new Set([
  'ADD',
  'ALL',
  'ALTER',
  'AND',
  'AS',
  'ASC',
  'BETWEEN',
  'BINARY',
  'BY',
  'CASE',
  'CAST',
  'CHAR',
  'CHARACTER',
  'COLLATE',
  'COLUMN',
  'CONVERT',
  'CREATE',
  'CROSS',
  'DATE',
  'DATETIME',
  'DECIMAL',
  'DELETE',
  'DESC',
  'DISTINCT',
  'DISTINCTROW',
  'DIV',
  'DOUBLE',
  'DROP',
  'EXCEPT',
  'EXISTS',
  'FALSE',
  'FLOAT',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'IF',
  'IN',
  'INDEX',
  'INNER',
  'INT',
  'INTEGER',
  'INTERSECT',
  'INTERVAL',
  'IS',
  'JOIN',
  'KEY',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NATURAL',
  'NOT',
  'NULL',
  'NUMERIC',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'PRIMARY',
  'REAL',
  'REFERENCES',
  'REGEXP',
  'RIGHT',
  'RLIKE',
  'ROW',
  'ROWS',
  'SELECT',
  'SEPARATOR',
  'SET',
  'SIGNED',
  'SOUNDS',
  'TABLE',
  'THEN',
  'TIME',
  'TIMESTAMP',
  'TO',
  'TRUE',
  'UNION',
  'UNKNOWN',
  'UNSIGNED',
  'UNIQUE',
  'UPDATE',
  'USING',
  'VALUES',
  'VARCHAR',
  'VIEW',
  'WHEN',
  'WHERE',
  'WITH',
  'XOR',
]);

/** Modifiers that may precede the first projection item. */
const PROJECTION_MODIFIERS = new Set([
  'ALL',
  'DISTINCT',
  'DISTINCTROW',
  'HIGH_PRIORITY',
  'SQL_CALC_FOUND_ROWS',
  'STRAIGHT_JOIN',
]);

/**
 * Fold a column name into snake_case so `userEmail`, `user_email` and
 * `USER EMAIL` compare equal. Digits stay attached to their word.
 */
function normalizeIdentifier(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** The words of a snake_case phrase, e.g. `api_key` -> `['api', 'key']`. */
function phraseWords(phrase: string): string[] {
  return phrase.split('_');
}

/**
 * True when the phrase occurs as a run of whole words inside `words`.
 * A single-word name also matches the concatenated form, so `apikey`
 * matches the phrase `api key`.
 */
function containsWords(words: string[], phrase: string): boolean {
  const target = phraseWords(phrase);
  if (words.length === 1) return words[0] === target.join('');
  if (target.length > words.length) return false;
  for (let start = 0; start + target.length <= words.length; start += 1) {
    let matched = true;
    for (let index = 0; index < target.length; index += 1) {
      if (words[start + index] !== target[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** True when the phrase is the tail of `words`. */
function endsWithWords(words: string[], phrase: string): boolean {
  const target = phraseWords(phrase);
  if (target.length > words.length) return false;
  const offset = words.length - target.length;
  for (let index = 0; index < target.length; index += 1) {
    if (words[offset + index] !== target[index]) return false;
  }
  return true;
}

/**
 * Decide whether a column name is sensitive.
 *
 * The policy has three tiers:
 *
 * 1. **Unambiguous marker** — `password`, `secret`, `pan`, `email`, `phone`,
 *    `ssn`, … are a secret in every schema and match wherever they appear.
 * 2. **Recognised compound**, matched at the **end** of the name — `api_key`
 *    and `encryption_key` hold a secret, while `encryption_key_version_id`,
 *    `notes_key_version` and `key_ref` merely mention a key.
 * 3. **Token / hash family**, matched anywhere — `access_token_enc`,
 *    `token_hash` and `qr_token_hash` are secrets, while `commit_hash` and
 *    `user_agent_hash` are content digests.
 *
 * The words `key`, `token`, `hash`, `pin`, `tel`, `mail`, `cc`, `pw` and
 * `pass` are never sensitive on their own: they are the words that produced
 * the largest number of false positives (a Laravel `cache.key`, a `*_key_id`
 * foreign key, a `commit_hash`). A `*_token` column is sensitive; a bare
 * `token` column is not.
 */
export function isSensitiveColumn(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

  const snake = normalizeIdentifier(normalized);
  if (!snake) return false;
  const words = snake.split('_');

  if (words.some((word) => SENSITIVE_TOKENS.has(word))) return true;
  if (SENSITIVE_COMPOUNDS.some((phrase) => endsWithWords(words, phrase))) return true;
  if (SENSITIVE_TOKEN_FAMILIES.some((phrase) => containsWords(words, phrase))) return true;
  // A column named `*_token` holds a token; a bare `token` column usually
  // holds an identifier.
  if (words.length > 1 && words[words.length - 1] === 'token') return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Source-aware masking (D-05 / H-1)                                    */
/* ------------------------------------------------------------------ */

const parserModule = sqlParser as unknown as typeof import('node-sql-parser');
const parser = new parserModule.Parser();

type AstRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AstRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** One resolved output column of a SELECT list. */
interface ResolvedColumn {
  /** The label MySQL would report for the column. */
  name: string;
  /** The value may contain a secret. */
  sensitive: boolean;
  /** The source could not be resolved; the column must be treated as secret. */
  unknown: boolean;
  /** The output column carries an explicit alias. */
  aliased: boolean;
}

/** A table a SELECT reads from. */
interface Relation {
  /** Alias or table name, lower-cased. */
  alias: string;
  /**
   * `physical` — a real table: the column names are the real column names,
   * so the name-based rule is the only signal available.
   * `derived` — a derived table or CTE whose output columns are known.
   * `opaque` — a derived table whose output columns could not be enumerated.
   */
  kind: 'physical' | 'derived' | 'opaque';
  /** The output columns, for `derived` relations. */
  columns: ResolvedColumn[];
  /** The relation could not be resolved safely; a star over it is dangerous. */
  dangerous: boolean;
}

/** The result of resolving one SELECT list. */
interface SelectResolution {
  /** The output columns that could be resolved. */
  columns: ResolvedColumn[];
  /** Every `*` in the list was expanded into concrete columns. */
  complete: boolean;
  /** A `*` could not be resolved and the output names may be aliased. */
  dangerous: boolean;
}

interface ProjectionItem {
  /** Explicit or bare alias of the item, when it has one. */
  alias: string | null;
  /** Column names the item references. */
  referenced: string[];
  /** True for a `*` item, which expands to every column of the table. */
  star: boolean;
}

function isWord(token: Token | undefined): boolean {
  return token !== undefined && token.kind === 'word';
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.value === value;
}

/**
 * Describe one projection item: its alias and the columns it reads from.
 * A sensitive column that only appears inside an expression
 * (`CONCAT(password) AS x`) is still found here.
 */
function analyzeProjection(tokens: Token[]): ProjectionItem {
  let start = 0;
  while (
    start < tokens.length &&
    isWord(tokens[start]) &&
    PROJECTION_MODIFIERS.has(tokens[start].value.toUpperCase())
  ) {
    start += 1;
  }
  const body = tokens.slice(start);
  const star = body.length === 1 && isPunct(body[0], '*');
  if (body.length === 0) return { alias: null, referenced: [], star };

  let alias: string | null = null;
  let aliasIndex = -1;

  // `expr AS alias`
  for (let i = 0; i < body.length; i += 1) {
    const token = body[i];
    if (!isWord(token) || token.depth !== 0) continue;
    if (token.value.toUpperCase() !== 'AS') continue;
    const next = body[i + 1];
    if (isWord(next) && next.depth === 0) {
      alias = next.value;
      aliasIndex = i + 1;
    }
    break;
  }

  if (!alias) {
    // `expr alias` — only when the trailing word follows a complete
    // expression (`col alias`, `func(...) alias`). `a + b` ends in a column,
    // not an alias.
    const last = body[body.length - 1];
    const previous = body[body.length - 2];
    const aliasLike =
      isWord(last) &&
      last.depth === 0 &&
      (isWord(previous) || isPunct(previous, ')')) &&
      !isPunct(previous, '.');
    if (aliasLike) {
      alias = last.value;
      aliasIndex = body.length - 1;
    }
  }

  const referenced: string[] = [];
  for (let i = 0; i < body.length; i += 1) {
    if (i === aliasIndex) continue;
    const token = body[i];
    if (!isWord(token)) continue;
    const next = body[i + 1];
    const previous = body[i - 1];
    const sensitive = isSensitiveColumn(token.value);
    if (!sensitive) {
      if (isPunct(next, '(')) continue; // function name
      if (isPunct(next, '.')) continue; // table/database qualifier
      if (isWord(previous) && previous.value.toUpperCase() === 'AS') continue; // cast type
      if (SQL_KEYWORDS.has(token.value.toUpperCase())) continue; // syntax
    }
    referenced.push(token.value);
  }

  return { alias, referenced, star };
}

/** Split the SELECT list of a statement into its projection items. */
function projectionItems(sql: string): ProjectionItem[] {
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch {
    return [];
  }
  const significant = tokens.filter((token) => token.kind !== 'comment');

  let selectIndex = -1;
  for (let i = 0; i < significant.length; i += 1) {
    const token = significant[i];
    if (isWord(token) && token.depth === 0 && token.value.toUpperCase() === 'SELECT') {
      selectIndex = i;
      break;
    }
  }
  if (selectIndex === -1) return [];

  const items: Token[][] = [];
  let current: Token[] = [];
  for (let i = selectIndex + 1; i < significant.length; i += 1) {
    const token = significant[i];
    if (isWord(token) && token.depth === 0 && token.value.toUpperCase() === 'FROM') break;
    if (isPunct(token, ',') && token.depth === 0) {
      items.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) items.push(current);

  return items.map(analyzeProjection);
}

/**
 * True when the statement is not a flat single SELECT, so the token scan
 * cannot see every output column: it has a CTE, a UNION branch or a derived
 * table in the FROM clause.
 */
function hasComplexShape(sql: string): boolean {
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch {
    return true;
  }
  const significant = tokens.filter((token) => token.kind !== 'comment');
  let fromIndex = -1;
  for (let i = 0; i < significant.length; i += 1) {
    const token = significant[i];
    if (!isWord(token)) continue;
    const word = token.value.toUpperCase();
    if (word === 'WITH' || word === 'UNION') return true;
    if (word === 'FROM' && token.depth === 0) {
      fromIndex = i;
      break;
    }
  }
  if (fromIndex === -1) return false;
  for (let i = fromIndex + 1; i < significant.length; i += 1) {
    const token = significant[i];
    if (isPunct(token, '(') && token.depth === 0) {
      const next = significant[i + 1];
      if (isWord(next) && next.value.toUpperCase() === 'SELECT') return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* AST walking                                                         */
/* ------------------------------------------------------------------ */

/** Parse a statement; returns null when the parser cannot model it. */
function parseStatement(sql: string): AstRecord | null {
  try {
    const parsed: unknown = parser.astify(sql, { database: 'MySQL' });
    return firstSelect(parsed);
  } catch {
    return null;
  }
}

/** The first SELECT of a parsed statement (a statement list is possible). */
function firstSelect(parsed: unknown): AstRecord | null {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const select = firstSelect(item);
      if (select) return select;
    }
    return null;
  }
  if (!isRecord(parsed)) return null;
  return parsed.type === 'select' ? parsed : null;
}

/**
 * Collect the column references of an expression. A nested SELECT only
 * contributes its own projection: its FROM list belongs to the inner query.
 */
function collectColumnRefs(node: unknown, out: AstRecord[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectColumnRefs(item, out);
    return;
  }
  if (!isRecord(node)) return;
  if (node.type === 'column_ref') {
    out.push(node);
    return;
  }
  if (node.type === 'select') {
    const columns = Array.isArray(node.columns) ? node.columns : [];
    for (const item of columns) {
      if (isRecord(item)) collectColumnRefs(item.expr, out);
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'tableList' || key === 'columnList') continue;
    collectColumnRefs(value, out);
  }
}

/** The label MySQL would report for an unaliased projection item. */
function naturalName(expr: unknown): string {
  if (!isRecord(expr)) return '';
  if (expr.type === 'column_ref') return String(expr.column ?? '');
  return '';
}

/**
 * Resolve one column reference against the relations of its SELECT.
 *
 * A reference to a physical table can only be judged by its name; a
 * reference to a derived table or CTE is judged by what that relation
 * resolved to. An unresolvable reference is reported as `unknown` so the
 * caller fails closed.
 */
function resolveRef(
  ref: AstRecord,
  relations: Relation[],
): { sensitive: boolean; unknown: boolean } {
  const column = String(ref.column ?? '');
  const table = ref.table == null ? null : String(ref.table).toLowerCase();

  if (column === '*') {
    let sensitive = false;
    let unknown = false;
    for (const relation of relations) {
      if (table && relation.alias !== table) continue;
      if (relation.kind !== 'derived') {
        unknown = true;
        continue;
      }
      for (const output of relation.columns) {
        sensitive = sensitive || output.sensitive;
        unknown = unknown || output.unknown;
      }
    }
    return { sensitive, unknown };
  }

  if (table) {
    const relation = relations.find((entry) => entry.alias === table);
    if (!relation) return { sensitive: false, unknown: true };
    if (relation.kind !== 'derived') {
      return { sensitive: isSensitiveColumn(column), unknown: relation.dangerous };
    }
    const found = relation.columns.find(
      (entry) => entry.name.toLowerCase() === column.toLowerCase(),
    );
    if (!found) return { sensitive: false, unknown: true };
    return { sensitive: found.sensitive, unknown: found.unknown };
  }

  // Unqualified: every relation could hold the column.
  let sensitive = false;
  let unknown = false;
  let resolved = false;
  for (const relation of relations) {
    if (relation.kind !== 'derived') {
      // A physical table: the column name is the only signal available.
      resolved = true;
      if (isSensitiveColumn(column)) sensitive = true;
      unknown = unknown || relation.dangerous;
      continue;
    }
    const found = relation.columns.find(
      (entry) => entry.name.toLowerCase() === column.toLowerCase(),
    );
    if (!found) {
      unknown = true;
      continue;
    }
    resolved = true;
    sensitive = sensitive || found.sensitive;
    unknown = unknown || found.unknown;
  }
  if (!resolved) return { sensitive: false, unknown: true };
  return { sensitive, unknown };
}

/** Resolve one projection item into its output column. */
function resolveProjection(expr: unknown, alias: unknown, relations: Relation[]): ResolvedColumn {
  const explicitAlias = typeof alias === 'string' && alias.length > 0 ? alias : null;
  const name = explicitAlias ?? naturalName(expr);
  const refs: AstRecord[] = [];
  collectColumnRefs(expr, refs);
  let sensitive = false;
  let unknown = false;
  for (const ref of refs) {
    const resolution = resolveRef(ref, relations);
    sensitive = sensitive || resolution.sensitive;
    unknown = unknown || resolution.unknown;
  }
  return { name, sensitive, unknown, aliased: explicitAlias !== null };
}

/** The relations a SELECT reads from, in FROM order. */
function buildRelations(from: unknown, scope: Map<string, Relation>): Relation[] {
  const relations: Relation[] = [];
  if (!Array.isArray(from)) return relations;
  for (const entry of from) {
    if (!isRecord(entry)) continue;
    const expr = entry.expr;
    if (isRecord(expr)) {
      const inner = expr.ast ?? expr;
      if (isRecord(inner) && inner.type === 'select') {
        const relation = relationFromSelect(inner, scope);
        relation.alias = entry.as == null ? '' : String(entry.as).toLowerCase();
        relations.push(relation);
        continue;
      }
    }
    const table = entry.table == null ? null : String(entry.table);
    if (table === null) continue;
    const alias = (entry.as == null ? table : String(entry.as)).toLowerCase();
    const cte = scope.get(table.toLowerCase());
    if (cte) {
      relations.push({ ...cte, alias });
      continue;
    }
    relations.push({
      alias,
      kind: 'physical',
      columns: [],
      dangerous: false,
    });
  }
  return relations;
}

/** Describe a derived table or CTE as a relation. */
function relationFromSelect(node: AstRecord, scope: Map<string, Relation>): Relation {
  const resolution = resolveSelect(node, scope);
  if (resolution.dangerous) {
    return { alias: '', kind: 'opaque', columns: [], dangerous: true };
  }
  if (resolution.complete) {
    return {
      alias: '',
      kind: 'derived',
      columns: resolution.columns,
      dangerous: false,
    };
  }
  // The column list could not be enumerated. It is still safe when no output
  // column was aliased, because then the names are the real column names of
  // the underlying table and the name-based rule covers them.
  const hasAlias = resolution.columns.some((column) => column.aliased);
  if (hasAlias) {
    return { alias: '', kind: 'opaque', columns: [], dangerous: true };
  }
  return { alias: '', kind: 'physical', columns: [], dangerous: false };
}

/**
 * Resolve a SELECT list into its output columns.
 *
 * Every SELECT in the statement is visited: the main query, a derived table
 * in the FROM clause, a CTE body and the branches of a UNION.
 */
function resolveSelect(node: AstRecord, ctes: Map<string, Relation>): SelectResolution {
  const scope = new Map(ctes);
  const withClause = node.with;
  if (Array.isArray(withClause)) {
    for (const entry of withClause) {
      if (!isRecord(entry)) continue;
      const name = cteName(entry);
      if (!name) continue;
      const body = cteBody(entry);
      if (!body) continue;
      const relation = relationFromSelect(body, scope);
      const declared = declaredCteColumns(entry);
      if (declared.length > 0 && relation.kind === 'derived') {
        relation.columns = relation.columns.map((column, index) => ({
          ...column,
          name: declared[index] ?? column.name,
        }));
      }
      scope.set(name, relation);
    }
  }

  const relations = buildRelations(node.from, scope);
  const outputs: ResolvedColumn[] = [];
  let complete = true;
  let dangerous = false;

  const items = Array.isArray(node.columns) ? node.columns : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const expr = item.expr;
    if (isRecord(expr) && expr.type === 'column_ref' && String(expr.column ?? '') === '*') {
      const qualifier = expr.table == null ? null : String(expr.table).toLowerCase();
      const targets = qualifier
        ? relations.filter((relation) => relation.alias === qualifier)
        : relations;
      if (targets.length === 0) {
        // The qualifier names no relation of this SELECT, so the columns the
        // star expands to are unknown.
        complete = false;
        dangerous = true;
        continue;
      }
      if (targets.every((relation) => relation.kind === 'derived')) {
        // Copy the columns: a UNION branch below may mark them as secret,
        // and the relation must keep its own resolution.
        for (const relation of targets) {
          outputs.push(...relation.columns.map((column) => ({ ...column })));
        }
        continue;
      }
      complete = false;
      // A star over physical tables keeps the real column names, so the
      // name-based rule still applies. Anything else can hide a secret
      // behind an alias, so the statement is failed closed.
      const sound = targets.every(
        (relation) => relation.kind === 'physical' && !relation.dangerous,
      );
      if (!sound) dangerous = true;
      continue;
    }
    outputs.push(resolveProjection(expr, item.as, relations));
  }

  // A UNION returns the values of every branch, so a branch that carries a
  // secret makes the whole output column a secret.
  const next = node._next;
  if (isRecord(next) && next.type === 'select') {
    const branch = resolveSelect(next, scope);
    branch.columns.forEach((column, index) => {
      if (index < outputs.length) {
        outputs[index].sensitive = outputs[index].sensitive || column.sensitive;
        outputs[index].unknown = outputs[index].unknown || column.unknown;
        return;
      }
      outputs.push(column);
    });
    if (!branch.complete) complete = false;
    if (branch.dangerous) dangerous = true;
  }

  return { columns: outputs, complete, dangerous };
}

/** The name a CTE is stored under. */
function cteName(entry: AstRecord): string {
  const name = entry.name;
  if (isRecord(name)) return String(name.value ?? '').toLowerCase();
  if (typeof name === 'string') return name.toLowerCase();
  return '';
}

/** The SELECT body of a CTE. */
function cteBody(entry: AstRecord): AstRecord | null {
  const stmt = entry.stmt;
  if (!isRecord(stmt)) return null;
  const ast = stmt.ast ?? stmt;
  return isRecord(ast) ? ast : null;
}

/** The explicit column list of a CTE (`WITH cte (a, b) AS ...`). */
function declaredCteColumns(entry: AstRecord): string[] {
  const columns = entry.columns;
  if (!Array.isArray(columns)) return [];
  return columns.map((column) => (isRecord(column) ? String(column.column ?? '') : ''));
}

/**
 * Link the resolved output columns to the columns of the result set.
 *
 * The alias is the strongest link; the position is used when the projection
 * lines up one-to-one with the result columns.
 */
function markSourceColumns(
  outputs: ResolvedColumn[],
  columns: QueryColumn[],
  sensitive: boolean[],
): void {
  for (const output of outputs) {
    if (!output.name) continue;
    const index = columns.findIndex(
      (column) => column.name.toLowerCase() === output.name.toLowerCase(),
    );
    if (index === -1) continue;
    if (output.sensitive || output.unknown) sensitive[index] = true;
  }

  if (outputs.length !== columns.length) return;
  outputs.forEach((output, index) => {
    if (output.sensitive || output.unknown) sensitive[index] = true;
  });
}

/**
 * Mark the result columns whose *source* is a sensitive column. The output
 * label is not enough: MySQL reports an empty original name for anything
 * that is not a plain column reference, so `SELECT CONCAT(password) AS x`
 * would otherwise return the secret in cleartext.
 *
 * The analysis covers the whole statement: the main SELECT, a derived table
 * in the FROM clause, a CTE body and every branch of a UNION. When a source
 * cannot be resolved the column is marked sensitive — over-masking is the
 * safe failure mode.
 */
function sourceSensitiveColumns(sql: string, columns: QueryColumn[]): boolean[] {
  const sensitive = columns.map(() => false);
  const ast = parseStatement(sql);
  if (!ast) {
    // The parser could not model the statement. The token scan still covers
    // a flat SELECT, but anything with a CTE, a UNION or a derived table
    // has output columns the scan cannot see, so it fails closed.
    if (hasComplexShape(sql)) return columns.map(() => true);
    return flatSourceSensitiveColumns(sql, columns, sensitive);
  }

  const resolution = resolveSelect(ast, new Map());
  if (resolution.dangerous) return columns.map(() => true);
  markSourceColumns(resolution.columns, columns, sensitive);
  return sensitive;
}

/**
 * The token-based analysis of a flat SELECT list. It is the fallback for
 * statements the parser cannot model.
 */
function flatSourceSensitiveColumns(
  sql: string,
  columns: QueryColumn[],
  sensitive: boolean[],
): boolean[] {
  const items = projectionItems(sql);
  if (items.length === 0) return sensitive;

  const mark = (index: number, item: ProjectionItem): void => {
    if (index < 0 || index >= sensitive.length) return;
    if (item.referenced.some((name) => isSensitiveColumn(name))) sensitive[index] = true;
  };

  // An explicit alias is the strongest link between item and result column.
  for (const item of items) {
    if (!item.alias) continue;
    const index = columns.findIndex(
      (column) => column.name.toLowerCase() === item.alias!.toLowerCase(),
    );
    mark(index, item);
  }

  // Otherwise fall back to position, but only when the projection lines up
  // one-to-one with the result columns and no item expands to many columns.
  const positional = items.length === columns.length && !items.some((item) => item.star);
  if (positional) {
    items.forEach((item, index) => mark(index, item));
  }

  return sensitive;
}

function maskCell(value: CellValue): CellValue {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' && value.length === 0) return value;
  if (typeof value === 'object' && value !== null && '__type' in value) {
    const binary = value as { length?: number };
    return `••••••••${binary.length ? ` (${binary.length} bytes)` : ''}`;
  }
  return '••••••••';
}

export interface MaskOptions {
  /** Masking is on unless the deployment disabled it. */
  enabled: boolean;
  /** Reveal masked values (only ever set after the write unlock). */
  reveal: boolean;
  /** Statement the rows came from; used to trace sensitive source columns. */
  sql?: string;
}

export function maskResultRows(
  columns: QueryColumn[],
  rows: CellValue[][],
  options: MaskOptions,
): { rows: CellValue[][]; columns: QueryColumn[]; masked: boolean } {
  const sourceSensitive = options.sql
    ? sourceSensitiveColumns(options.sql, columns)
    : columns.map(() => false);

  const marked = columns.map((column, index) => ({
    ...column,
    sensitive:
      column.sensitive ||
      isSensitiveColumn(column.name) ||
      isSensitiveColumn(column.originalName) ||
      sourceSensitive[index] === true,
  }));

  if (!options.enabled || options.reveal) {
    return { rows, columns: marked, masked: false };
  }

  let masked = false;
  const sensitiveIndexes = new Set<number>();
  marked.forEach((column, index) => {
    if (column.sensitive) sensitiveIndexes.add(index);
  });
  if (sensitiveIndexes.size === 0) {
    return { rows, columns: marked, masked: false };
  }

  const nextRows = rows.map((row) =>
    row.map((cell, index) => {
      if (!sensitiveIndexes.has(index)) return cell;
      if (cell === null || cell === undefined || cell === '') return cell;
      masked = true;
      return maskCell(cell);
    }),
  );
  return { rows: nextRows, columns: marked, masked };
}
