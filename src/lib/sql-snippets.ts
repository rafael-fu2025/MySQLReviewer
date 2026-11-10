/**
 * Pure data and logic behind the editor capability upgrades: the built-in SQL
 * snippet templates, the schema hover resolution, and the mapping from the
 * persisted format options to `sql-formatter` invocation options.
 *
 * No CodeMirror, React, or formatter imports live here — everything is plain
 * data and string logic so the unit tests can exercise it without a DOM.
 */

/* ------------------------------------------------------------------ *
 * Snippet templates
 * ------------------------------------------------------------------ */

/**
 * A built-in completion template. `body` uses CodeMirror's snippet syntax:
 * `${1:placeholder}` opens a tab field (the same number may appear twice to
 * mirror one edit into several positions), and `${0}` is where the caret
 * finally rests after Tab-through.
 */
export interface SqlSnippetTemplate {
  /** What the user types to trigger the template. */
  label: string;
  /** Short description shown next to the label in the completion list. */
  detail: string;
  /** CodeMirror snippet template inserted on accept. */
  body: string;
}

/**
 * A short curated set. Write statements (`upd`, `del`) are "guarded": the
 * template always contains a WHERE clause so an accidental accept cannot
 * produce an unbounded write.
 */
export const SQL_SNIPPET_TEMPLATES: readonly SqlSnippetTemplate[] = [
  {
    label: 'sel',
    detail: 'SELECT … FROM … WHERE …',
    body: 'SELECT ${1:columns}\nFROM ${2:table}\nWHERE ${3:condition}',
  },
  {
    label: 'join',
    detail: 'JOIN … ON …',
    body: 'JOIN ${1:table} ON ${2:left.column} = ${3:right.column}',
  },
  {
    label: 'lj',
    detail: 'LEFT JOIN … ON …',
    body: 'LEFT JOIN ${1:table} ON ${2:left.column} = ${3:right.column}',
  },
  {
    label: 'cte',
    detail: 'WITH name AS (…) SELECT …',
    body: 'WITH ${1:name} AS (\n  ${2:select}\n)\nSELECT ${3:columns}\nFROM ${1:name}',
  },
  {
    label: 'winrow',
    detail: 'ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)',
    body: 'ROW_NUMBER() OVER (PARTITION BY ${1:partition} ORDER BY ${2:ordering}) AS ${3:row_num}',
  },
  {
    label: 'winrank',
    detail: 'RANK() OVER (PARTITION BY … ORDER BY …)',
    body: 'RANK() OVER (PARTITION BY ${1:partition} ORDER BY ${2:ordering}) AS ${3:rank}',
  },
  {
    label: 'order',
    detail: 'ORDER BY …',
    body: 'ORDER BY ${1:column} ${2:DESC}',
  },
  {
    label: 'group',
    detail: 'GROUP BY …',
    body: 'GROUP BY ${1:columns}',
  },
  {
    label: 'ins',
    detail: 'INSERT INTO … VALUES …',
    body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})',
  },
  {
    label: 'upd',
    detail: 'UPDATE with a required WHERE guard',
    body: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}',
  },
  {
    label: 'del',
    detail: 'DELETE with a required WHERE guard',
    body: 'DELETE FROM ${1:table}\nWHERE ${2:condition}',
  },
];

/**
 * A saved snippet as the completion list sees it. Kept as plain data so this
 * module stays CodeMirror-free; the editor hands the objects straight to the
 * completion machinery (the shape matches a `Completion` with `apply` text,
 * which CodeMirror inserts verbatim — no snippet markers are parsed).
 */
export interface SavedSnippetCompletion {
  label: string;
  detail: string;
  type: string;
  apply: string;
}

/**
 * Turns the user's saved snippets into completion entries. The SQL is
 * inserted as-is: snippet bodies may legitimately contain `${}` markers from
 * prepared statements or uppercase `PLACEHOLDER` tokens, so they must never
 * be reinterpreted as template fields.
 */
export function savedSnippetCompletions(
  snippets: ReadonlyArray<{ title: string; sql: string }>,
): SavedSnippetCompletion[] {
  return snippets
    .filter((snippet) => snippet.title.trim().length > 0 && snippet.sql.trim().length > 0)
    .map((snippet) => ({
      label: snippet.title,
      detail: 'saved snippet',
      type: 'text',
      apply: snippet.sql,
    }));
}

/* ------------------------------------------------------------------ *
 * Schema hover resolution
 * ------------------------------------------------------------------ */

/** Metadata for one column; plain `string` entries become name-only columns. */
export interface HoverColumnMeta {
  name: string;
  dataType?: string | null;
  primaryKey?: boolean;
  /** Referenced table when the column is part of a foreign key. */
  referencesTable?: string | null;
  nullable?: boolean | null;
}

export interface HoverTableMeta {
  name: string;
  /** Column names, or richer column metadata when the app has it. */
  columns: ReadonlyArray<string | HoverColumnMeta>;
  engine?: string | null;
  rowsEstimate?: number | null;
}

/**
 * Lookup structure for hover resolution. Keys are lower-cased identifiers
 * because MySQL identifiers compare case-insensitively in statements, while
 * the schema store keeps the declared casing.
 */
export interface HoverIndex {
  tables: Map<string, HoverTableMeta>;
  /** Lower-cased column name → metadata plus the table that declares it. */
  columns: Map<string, HoverColumnEntry[]>;
}

interface HoverColumnEntry {
  table: string;
  meta: HoverColumnMeta;
}

/** Resolved hover content rendered into the editor tooltip. */
export interface HoverInfo {
  kind: 'column' | 'table';
  title: string;
  lines: string[];
}

export function buildHoverIndex(tables: ReadonlyArray<HoverTableMeta>): HoverIndex {
  const index: HoverIndex = { tables: new Map(), columns: new Map() };
  for (const table of tables) {
    const key = table.name.toLowerCase();
    if (!key || index.tables.has(key)) continue;
    index.tables.set(key, table);
    for (const column of table.columns) {
      const meta: HoverColumnMeta = typeof column === 'string' ? { name: column } : column;
      const columnKey = meta.name.toLowerCase();
      if (!columnKey) continue;
      const bucket = index.columns.get(columnKey);
      const entry: HoverColumnEntry = { table: table.name, meta };
      if (bucket) {
        if (!bucket.some((existing) => existing.table === table.name)) bucket.push(entry);
      } else {
        index.columns.set(columnKey, [entry]);
      }
    }
  }
  return index;
}

/**
 * The identifier immediately before a dot that ends at `wordFrom`, or null
 * when the hovered word is not dotted. Works on a single line's text with
 * line-local offsets. Backtick-quoted qualifiers are unwrapped; a quote
 * without a matching close is ignored rather than swallowing the line.
 */
export function qualifierBefore(text: string, wordFrom: number): string | null {
  if (wordFrom <= 0 || text[wordFrom - 1] !== '.') return null;
  let start = wordFrom - 1;
  if (start > 0 && text[start - 1] === '`') {
    const close = text.lastIndexOf('`', start - 2);
    if (close >= 0 && start - 2 - close <= 64) {
      return text.slice(close + 1, start - 1);
    }
    return null;
  }
  start -= 1;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start -= 1;
  const qualifier = text.slice(start, wordFrom - 1);
  return /^[\w$][\w$]*$/.test(qualifier) ? qualifier : null;
}

function columnLines(meta: HoverColumnMeta, tables: string[]): string[] {
  const lines: string[] = [];
  if (meta.dataType) lines.push(meta.dataType);
  if (meta.primaryKey) lines.push('PK');
  if (meta.referencesTable) lines.push(`FK → ${meta.referencesTable}`);
  if (meta.nullable === true) lines.push('nullable');
  if (meta.nullable === false) lines.push('NOT NULL');
  if (tables.length > 1) lines.push(`column in ${tables.length} tables · ${tables.join(', ')}`);
  return lines;
}

function tableLines(meta: HoverTableMeta): string[] {
  const parts: string[] = [];
  if (meta.engine) parts.push(meta.engine);
  if (meta.rowsEstimate != null && meta.rowsEstimate > 0) {
    parts.push(`${meta.rowsEstimate.toLocaleString('en-US')} rows`);
  }
  if (parts.length > 0) {
    parts.push(`${meta.columns.length} columns`);
    return [parts.join(' · ')];
  }
  return [`${meta.columns.length} columns`];
}

/**
 * Resolves a hovered identifier to tooltip content.
 *
 * - `table.column` resolves through the qualifier: an unknown qualifier or a
 *   word that is not a column of it yields null, so table aliases never
 *   produce misleading information.
 * - A bare word resolves as a table first, then as a column — when several
 *   tables declare the same column name, the first table's metadata is shown
 *   together with the list of tables.
 */
export function resolveHover(
  word: string,
  qualifier: string | null,
  index: HoverIndex,
): HoverInfo | null {
  const key = word.toLowerCase();
  if (!key) return null;

  if (qualifier) {
    const table = index.tables.get(qualifier.toLowerCase());
    if (!table) return null;
    const column = table.columns.find(
      (entry) => (typeof entry === 'string' ? entry : entry.name).toLowerCase() === key,
    );
    if (!column) return null;
    const meta: HoverColumnMeta = typeof column === 'string' ? { name: column } : column;
    return {
      kind: 'column',
      title: `${table.name}.${meta.name}`,
      lines: columnLines(meta, [table.name]),
    };
  }

  const table = index.tables.get(key);
  if (table) {
    return { kind: 'table', title: table.name, lines: tableLines(table) };
  }

  const matches = index.columns.get(key);
  if (!matches || matches.length === 0) return null;
  const { table: firstTable, meta: primary } = matches[0];
  const tableNames = matches.map((entry) => entry.table);
  return {
    kind: 'column',
    title: `${firstTable}.${primary.name}`,
    lines: columnLines(primary, tableNames),
  };
}

/* ------------------------------------------------------------------ *
 * Format options
 * ------------------------------------------------------------------ */

export type FormatKeywordCase = 'upper' | 'lower' | 'preserve';
export type FormatIndent = '2' | '4' | 'tab';

export interface FormatOptions {
  keywordCase: FormatKeywordCase;
  indent: FormatIndent;
  linesBetweenQueries: 1 | 2;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  keywordCase: 'upper',
  indent: '2',
  linesBetweenQueries: 2,
};

export const FORMAT_KEYWORD_CASE_CHOICES: ReadonlyArray<{
  value: FormatKeywordCase;
  label: string;
}> = [
  { value: 'upper', label: 'Upper' },
  { value: 'lower', label: 'Lower' },
  { value: 'preserve', label: 'Preserve' },
];

export const FORMAT_INDENT_CHOICES: ReadonlyArray<{ value: FormatIndent; label: string }> = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: 'tab', label: 'Tab' },
];

export const FORMAT_LINES_CHOICES: ReadonlyArray<{ value: 1 | 2; label: string }> = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];

/** The subset of `sql-formatter` options the Format button passes through. */
export interface SqlFormatterInvocation {
  language: 'mysql';
  keywordCase: FormatKeywordCase;
  tabWidth?: number;
  useTabs?: boolean;
  linesBetweenQueries: number;
}

/** Maps the persisted options to what `format()` from `sql-formatter` takes. */
export function sqlFormatterOptions(options: FormatOptions): SqlFormatterInvocation {
  const invocation: SqlFormatterInvocation = {
    language: 'mysql',
    keywordCase: options.keywordCase,
    linesBetweenQueries: options.linesBetweenQueries,
  };
  if (options.indent === 'tab') {
    invocation.useTabs = true;
  } else {
    invocation.tabWidth = Number(options.indent);
  }
  return invocation;
}
