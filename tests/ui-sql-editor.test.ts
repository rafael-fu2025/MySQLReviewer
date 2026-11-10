import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findingRange } from '../src/lib/finding-range';
import {
  SQL_SNIPPET_TEMPLATES,
  buildHoverIndex,
  qualifierBefore,
  resolveHover,
  savedSnippetCompletions,
} from '../src/lib/sql-snippets';

/**
 * The lint diagnostics used to be whole-line marks, and the old empty-line
 * fallback (`line.from + 1`) bled one character into the next line. The range
 * now narrows to the token a finding points at (the rule engine reports a
 * 1-based column for token rules) and collapses to a zero-width point on an
 * empty line, which CodeMirror renders as a point mark.
 */
describe('lint finding ranges', () => {
  // A 20-character line starting at offset 100.
  const line = { from: 100, to: 120 };

  it('keeps the whole line when the finding has no column', () => {
    expect(findingRange(null, line, 'SELECT NULL = NULL x ')).toEqual({ from: 100, to: 120 });
    expect(findingRange(undefined, line, 'x'.repeat(20))).toEqual({ from: 100, to: 120 });
  });

  it('collapses an empty line to a zero-width point instead of bleeding', () => {
    expect(findingRange(null, { from: 100, to: 100 }, '')).toEqual({ from: 100, to: 100 });
  });

  it('narrows to the word token at the reported 1-based column', () => {
    const text = 'SELECT NOT IN (1)';
    // `NOT` starts at column 8 and spans three characters.
    expect(findingRange(8, { from: 0, to: text.length }, text)).toEqual({ from: 7, to: 10 });
  });

  it('marks a single character for a punctuation token', () => {
    const text = 'WHERE x = NULL';
    // `=` sits at column 8; no word starts there, so just that character.
    expect(findingRange(8, { from: 0, to: text.length }, text)).toEqual({ from: 7, to: 8 });
  });

  it('keeps the whole line when the column is out of range', () => {
    expect(findingRange(0, line, 'x'.repeat(20))).toEqual({ from: 100, to: 120 });
    expect(findingRange(99, line, 'x'.repeat(20))).toEqual({ from: 100, to: 120 });
  });

  it('clamps the token mark to the end of the line', () => {
    expect(findingRange(1, { from: 0, to: 3 }, 'NOT')).toEqual({ from: 0, to: 3 });
  });
});

/**
 * The editor offers a curated set of SQL templates as snippet completions and
 * resolves hovered identifiers against the loaded schema. Both live in the
 * pure `sql-snippets` module so they can be checked without a DOM.
 */

// CodeMirror parses `${N:placeholder}` fields (and `${0}` for the final
// caret); anything else containing braces would be inserted as garbage.
const SNIPPET_FIELD = /\$\{(?:\d+(?::[^{}]*)?|[^{}]*)\}/g;

describe('SQL snippet templates', () => {
  it('covers the curated trigger set with unique word-char labels', () => {
    const labels = SQL_SNIPPET_TEMPLATES.map((template) => template.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(
      expect.arrayContaining([
        'sel',
        'join',
        'lj',
        'cte',
        'winrow',
        'winrank',
        'order',
        'group',
        'ins',
        'upd',
        'del',
      ]),
    );
    // Word-char labels keep the `matchBefore(/[\w$]+/)` completion source
    // able to match every template as the identifier is typed.
    for (const label of labels) {
      expect(label).toMatch(/^[\w$]+$/);
    }
  });

  it('every template carries a detail and valid snippet field markers', () => {
    for (const template of SQL_SNIPPET_TEMPLATES) {
      expect(template.detail.length).toBeGreaterThan(0);
      // At least one tab field, so Tab-through lands somewhere useful.
      expect(template.body).toMatch(/\$\{\d/);
      const remainder = template.body.replace(SNIPPET_FIELD, '');
      // After stripping valid fields nothing but plain text may remain.
      expect(remainder).not.toMatch(/[{}]/);
      expect(remainder).not.toContain('$');
    }
  });

  it('write templates are guarded by a trailing WHERE clause', () => {
    const upd = SQL_SNIPPET_TEMPLATES.find((template) => template.label === 'upd');
    const del = SQL_SNIPPET_TEMPLATES.find((template) => template.label === 'del');
    for (const template of [upd, del]) {
      expect(template?.body.split('\n').at(-1)?.trim()).toMatch(/^WHERE /);
    }
    // The CTE name mirrors between the definition and the FROM clause.
    const cte = SQL_SNIPPET_TEMPLATES.find((template) => template.label === 'cte');
    expect(cte?.body.match(/\$\{1:name\}/g)?.length).toBe(2);
  });
});

describe('saved snippet completions', () => {
  it('maps titles to verbatim-apply entries tagged as saved snippets', () => {
    expect(
      savedSnippetCompletions([
        { title: 'Monthly totals', sql: 'SELECT SUM(x) FROM t WHERE ${month}' },
        { title: '  ', sql: 'SELECT 1' },
        { title: 'Empty', sql: '   ' },
      ]),
    ).toEqual([
      {
        label: 'Monthly totals',
        detail: 'saved snippet',
        type: 'text',
        // The apply text is kept as-is: `${}`-style markers and PLACEHOLDER
        // tokens must survive untouched.
        apply: 'SELECT SUM(x) FROM t WHERE ${month}',
      },
    ]);
  });
});

describe('schema hover resolution', () => {
  const index = buildHoverIndex([
    {
      name: 'users',
      columns: [
        { name: 'id', dataType: 'INT', primaryKey: true, nullable: false },
        { name: 'email', dataType: 'VARCHAR(255)', nullable: true },
        { name: 'dept_id', referencesTable: 'departments', nullable: true },
      ],
      engine: 'InnoDB',
      rowsEstimate: 12345,
    },
    {
      name: 'orders',
      columns: [
        { name: 'id', dataType: 'BIGINT' },
        { name: 'user_id', referencesTable: 'users' },
      ],
    },
    { name: 'names', columns: ['id'] },
  ]);

  it('shows a table with engine and row estimate', () => {
    expect(resolveHover('users', null, index)).toEqual({
      kind: 'table',
      title: 'users',
      lines: ['InnoDB · 12,345 rows · 3 columns'],
    });
  });

  it('falls back to the column count when engine and rows are missing', () => {
    expect(resolveHover('ORDERS', null, index)).toEqual({
      kind: 'table',
      title: 'orders',
      lines: ['2 columns'],
    });
  });

  it('resolves a column with type, PK and nullability', () => {
    expect(resolveHover('id', 'users', index)).toEqual({
      kind: 'column',
      title: 'users.id',
      lines: ['INT', 'PK', 'NOT NULL'],
    });
  });

  it('marks a foreign key with the referenced table', () => {
    expect(resolveHover('dept_id', 'users', index)?.lines).toContain('FK → departments');
    expect(resolveHover('user_id', 'orders', index)?.lines).toContain('FK → users');
  });

  it('resolves a bare column shared by tables with the declaring list', () => {
    expect(resolveHover('id', null, index)).toEqual({
      kind: 'column',
      title: 'users.id',
      lines: ['INT', 'PK', 'NOT NULL', 'column in 3 tables · users, orders, names'],
    });
  });

  it('handles plain-string columns and dotted qualifiers case-insensitively', () => {
    expect(resolveHover('email', 'USERS', index)).toEqual({
      kind: 'column',
      title: 'users.email',
      lines: ['VARCHAR(255)', 'nullable'],
    });
  });

  it('returns null for unknown words and alias-like qualifiers', () => {
    expect(resolveHover('nothing_here', null, index)).toBeNull();
    expect(resolveHover('id', 'u', index)).toBeNull();
    expect(resolveHover('nope', 'users', index)).toBeNull();
    expect(resolveHover('', null, index)).toBeNull();
  });

  it('extracts the qualifier before a dotted word', () => {
    expect(qualifierBefore('SELECT u.id FROM users u', 9)).toBe('u');
    expect(qualifierBefore('SELECT `my table`.id FROM t', 18)).toBe('my table');
    expect(qualifierBefore('SELECT id FROM t', 10)).toBeNull();
    // An unterminated backtick quote yields no qualifier instead of
    // swallowing the rest of the line.
    expect(qualifierBefore('SELECT `my table.id', 18)).toBeNull();
  });
});

describe('editor extension wiring', () => {
  const source = readFileSync(new URL('../src/components/SqlEditor.tsx', import.meta.url), 'utf8');

  it('merges snippet completions with the schema sources via language data', () => {
    // `sql()` registers its keyword/schema sources on the dialect's language
    // data facet; joining the same facet keeps all three sources merged.
    expect(source).toContain('MySQL.language.data.of({ autocomplete: completionSource })');
    expect(source).toContain('snippetCompletion(');
    expect(source).toContain('savedSnippetCompletions(snippets)');
  });

  it('adds a hover tooltip and leaves touch alone', () => {
    expect(source).toContain('hoverTooltip(');
    expect(source).toContain('hoverTime: 300');
  });
});
