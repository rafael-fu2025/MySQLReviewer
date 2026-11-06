import { describe, expect, it } from 'vitest';

import { splitStatements, tokenize } from '../server/review/tokenizer';
import { classifySql } from '../server/review/sql-classifier';
import { assertSqlScope } from '../server/db/scope';

/** The single sandbox database the member is allowed to touch. */
const SANDBOX = 'northwind_1';
/** A database the member must never reach. */
const FOREIGN = 'checkit_db';
const memberScope = { allowed: [SANDBOX] };

describe('DELIMITER is a client-side directive', () => {
  it('is not turned into a statement', () => {
    const parts = splitStatements('delimiter //');
    expect(parts).toHaveLength(0);
  });

  it('keeps a wrapped routine as one statement and drops the directive', () => {
    const script = [
      'delimiter //',
      'CREATE PROCEDURE p() BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END//',
      'delimiter ;',
    ].join('\n');
    const parts = splitStatements(script);
    expect(parts).toHaveLength(1);
    expect(parts[0].sql).toBe('CREATE PROCEDURE p() BEGIN\n  SELECT 1;\n  SELECT 2;\nEND');
    // The directive text must not survive anywhere in the statement.
    expect(parts[0].sql).not.toMatch(/delimiter/i);
  });

  it('supports a $$ terminator', () => {
    const script =
      'delimiter $$\nCREATE FUNCTION f() RETURNS INT BEGIN RETURN 1; END$$\ndelimiter ;';
    const parts = splitStatements(script);
    expect(parts).toHaveLength(1);
    expect(parts[0].sql).toBe('CREATE FUNCTION f() RETURNS INT BEGIN RETURN 1; END');
  });

  it('resets the terminator', () => {
    const script = ['delimiter //', 'SELECT 1//', 'delimiter ;', 'SELECT 2;'].join('\n');
    const parts = splitStatements(script);
    expect(parts.map((part) => part.sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does not treat a directive inside a string literal as a directive', () => {
    const parts = splitStatements("SELECT 'delimiter //' AS t;");
    expect(parts).toHaveLength(1);
    expect(parts[0].sql).toBe("SELECT 'delimiter //' AS t");
  });

  it('does not treat the word delimiter mid-line as a directive', () => {
    const parts = splitStatements('SELECT delimiter FROM t;');
    expect(parts).toHaveLength(1);
    expect(parts[0].sql).toBe('SELECT delimiter FROM t');
  });

  it('does not match a terminator inside a string, a comment or an identifier', () => {
    const parts = splitStatements(
      ['delimiter //', "SELECT 'a//b' AS x -- c//d", 'SELECT `we//ird` FROM t//'].join('\n'),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].sql).toContain("'a//b'");
    expect(parts[0].sql).toContain('-- c//d');
    expect(parts[0].sql).toContain('`we//ird`');
  });

  it('leaves the default semicolon splitting untouched', () => {
    const parts = splitStatements('SELECT 1; SELECT 2;');
    expect(parts.map((part) => part.sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('reports a wrapped routine as a single statement, not a multi-statement script', () => {
    const script = 'delimiter //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\ndelimiter ;';
    const classified = classifySql(script);
    expect(classified.statements).toHaveLength(1);
    expect(classified.multiStatement).toBe(false);
    expect(classified.empty).toBe(false);
    expect(classified.overall.needsUnlock).toBe(true);
  });
});

describe('a routine body is still subject to the member scope', () => {
  it('refuses a routine whose body reads a foreign database', async () => {
    const script = [
      'delimiter //',
      `CREATE PROCEDURE p() BEGIN SELECT * FROM ${FOREIGN}.attendances; END//`,
      'delimiter ;',
    ].join('\n');
    // The routine body is one statement; the scope check must still see the
    // foreign database inside it.
    await expect(assertSqlScope('any-profile', script, SANDBOX, memberScope)).rejects.toMatchObject(
      { status: 403 },
    );
  });

  it('allows a routine that only touches the sandbox', async () => {
    const script = [
      'delimiter //',
      `CREATE PROCEDURE p() BEGIN SELECT * FROM ${SANDBOX}.customers; END//`,
      'delimiter ;',
    ].join('\n');
    await expect(
      assertSqlScope('any-profile', script, SANDBOX, memberScope),
    ).resolves.toBeDefined();
  });

  it('refuses a routine that drops a foreign database', async () => {
    const script = [
      'delimiter //',
      `CREATE PROCEDURE p() BEGIN DROP TABLE ${FOREIGN}.t; END//`,
      'delimiter ;',
    ].join('\n');
    await expect(assertSqlScope('any-profile', script, SANDBOX, memberScope)).rejects.toMatchObject(
      { status: 403 },
    );
  });
});

describe('the tokenizer still reports the directive as a word', () => {
  it('keeps the raw text of a directive in the token list', () => {
    const tokens = tokenize('delimiter //');
    expect(tokens[0].value.toUpperCase()).toBe('DELIMITER');
  });
});
