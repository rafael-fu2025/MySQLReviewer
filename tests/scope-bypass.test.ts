import { describe, expect, it, vi } from 'vitest';

import {
  assertSqlScope,
  collectReferencedDatabases,
  containsExecutableComment,
} from '../server/db/scope';
import { tokenize } from '../server/review/tokenizer';

// The scope checker reads the profile scope from the store. The store is
// replaced here so the test does not depend on a connection profile on disk.
vi.mock('../server/store/profiles', () => ({
  getStoredProfile: async (id: string) => ({
    id,
    name: 'Unrestricted scope',
    databaseScope: 'all',
    allowedDatabases: [],
    allowServerWideInsights: true,
  }),
}));

/** The single sandbox database the member is allowed to touch. */
const SANDBOX = 'northwind_1';
/** A database the member must never reach. */
const FOREIGN = 'checkit_db';

/** The scope of a member: one sandbox database. */
const memberScope = { allowed: [SANDBOX] };

/** The scope checker must refuse a statement on a scoped connection. */
async function expectRefused(sql: string, code: string): Promise<void> {
  await expect(assertSqlScope('any-profile', sql, SANDBOX, memberScope)).rejects.toMatchObject({
    code,
    status: 403,
  });
}

/** The scope checker must accept a statement on a scoped connection. */
async function expectAllowed(sql: string): Promise<void> {
  await expect(assertSqlScope('any-profile', sql, SANDBOX, memberScope)).resolves.toMatchObject({
    mode: 'selected',
  });
}

describe('C-1: the `--` comment rule follows MySQL', () => {
  it('refuses a `--1` that hides a foreign database', async () => {
    await expectRefused(`SELECT COUNT(*)--1 FROM ${FOREIGN}.attendances`, 'DATABASE_NOT_ALLOWED');
  });

  it('refuses a `--1` that hides the whole server', async () => {
    await expectRefused(
      'SELECT COUNT(*)--1 FROM information_schema.tables',
      'DATABASE_NOT_ALLOWED',
    );
  });

  it('refuses the EXPLAIN form of the same statement', async () => {
    await expectRefused(
      `EXPLAIN SELECT COUNT(*)--1 FROM ${FOREIGN}.attendances`,
      'DATABASE_NOT_ALLOWED',
    );
  });

  it('refuses a genuine `--` comment that names a foreign database', async () => {
    // The server reads this as `SELECT COUNT(*)`: the comment runs to the end of
    // the line. The scope checker refuses it anyway, because a comment may only
    // make a statement more restricted, never less.
    await expectRefused(`SELECT COUNT(*)-- 1 FROM ${FOREIGN}.attendances`, 'DATABASE_NOT_ALLOWED');
  });

  it('refuses a foreign database on the line after a `--` comment', async () => {
    // The comment ends at the newline, so the server runs the whole statement.
    await expectRefused(`SELECT COUNT(*)-- 1\nFROM ${FOREIGN}.attendances`, 'DATABASE_NOT_ALLOWED');
  });

  it('tokenizes `--1` as two operators and a number', () => {
    const tokens = tokenize('SELECT 1--2');
    expect(tokens.some((token) => token.kind === 'comment')).toBe(false);
    expect(tokens.map((token) => token.value)).toEqual(['SELECT', '1', '-', '-', '2']);
  });

  it('still reads `-- ` and `#` as comments', () => {
    expect(tokenize('SELECT 1-- 2').some((token) => token.kind === 'comment')).toBe(true);
    expect(tokenize('SELECT 1--').some((token) => token.kind === 'comment')).toBe(true);
    expect(tokenize('SELECT 1#c').some((token) => token.kind === 'comment')).toBe(true);
    // `#` starts a comment anywhere on the line.
    expect(tokenize('SELECT 1 #c').some((token) => token.kind === 'comment')).toBe(true);
  });

  it('leaves a statement that ends in a comment alone', async () => {
    await expectAllowed(`SELECT COUNT(*) FROM ${SANDBOX}.attendances -- a note`);
  });
});

describe('C-2: MariaDB executable comments are blocked', () => {
  it('refuses a `/*M!` version comment', async () => {
    await expectRefused(
      `SELECT 1 /*M!50000UNION SELECT COUNT(*) FROM ${FOREIGN}.attendances*/`,
      'EXECUTABLE_COMMENT_NOT_ALLOWED',
    );
  });

  it('refuses a `/*!` version comment', async () => {
    await expectRefused(
      `SELECT 1 /*!50000UNION SELECT COUNT(*) FROM ${FOREIGN}.attendances*/`,
      'EXECUTABLE_COMMENT_NOT_ALLOWED',
    );
  });

  it('flags `/*M!` whatever the case of the M is', () => {
    expect(containsExecutableComment('SELECT 1 /*M!50000UNION SELECT 2*/')).toBe(true);
    expect(containsExecutableComment('SELECT 1 /*m!50000UNION SELECT 2*/')).toBe(true);
    expect(containsExecutableComment('SELECT 1 /*!50000UNION SELECT 2*/')).toBe(true);
  });

  it('does not flag the comments the server ignores', () => {
    // `/* !` and `/**!` are ordinary comments for the server.
    expect(containsExecutableComment('SELECT 1 /* !50000UNION SELECT 2*/')).toBe(false);
    expect(containsExecutableComment('SELECT 1 /**!50000UNION SELECT 2*/')).toBe(false);
    // A version comment inside a string literal is not a comment at all.
    expect(containsExecutableComment("SELECT '/*!50000UNION SELECT 2*/' AS note")).toBe(false);
  });
});

describe('C-3: `--` does not hide a `/*!` comment', () => {
  it('refuses a statement that hides a version comment behind a `--`', async () => {
    await expectRefused(
      `SELECT 5--3 /*!50000UNION SELECT COUNT(*) FROM ${FOREIGN}.attendances*/`,
      'EXECUTABLE_COMMENT_NOT_ALLOWED',
    );
  });
});

describe('H-2: every statement shape that names a foreign database', () => {
  it('refuses CREATE INDEX on a foreign table', async () => {
    await expectRefused(`CREATE INDEX ix ON ${FOREIGN}.t (a)`, 'DATABASE_NOT_ALLOWED');
  });

  it('refuses DROP INDEX on a foreign table', async () => {
    await expectRefused(`DROP INDEX ix ON ${FOREIGN}.t`, 'DATABASE_NOT_ALLOWED');
  });

  it('refuses DROP DATABASE of a foreign database', async () => {
    await expectRefused(`DROP DATABASE ${FOREIGN}`, 'DATABASE_NOT_ALLOWED');
  });

  it('refuses RENAME TABLE into a foreign database', async () => {
    await expectRefused(`RENAME TABLE ${SANDBOX}.a TO ${FOREIGN}.b`, 'DATABASE_NOT_ALLOWED');
  });

  it('refuses LOCK TABLES on a foreign table', async () => {
    await expectRefused(`LOCK TABLES ${FOREIGN}.t READ`, 'DATABASE_NOT_ALLOWED');
  });

  it('refuses the remaining object, view and routine statements', async () => {
    const statements = [
      `DROP TABLE ${FOREIGN}.t`,
      `TRUNCATE TABLE ${FOREIGN}.t`,
      `ALTER TABLE ${FOREIGN}.t ADD COLUMN b INT`,
      `CREATE TABLE ${FOREIGN}.t (a INT)`,
      `CREATE TABLE IF NOT EXISTS ${FOREIGN}.t (a INT)`,
      `DROP TABLE IF EXISTS ${FOREIGN}.t`,
      `CREATE TABLE tmp LIKE ${FOREIGN}.t`,
      `CREATE VIEW ${FOREIGN}.v AS SELECT 1`,
      `DROP VIEW ${FOREIGN}.v`,
      `CREATE TRIGGER ${FOREIGN}.tr BEFORE INSERT ON t FOR EACH ROW SET @x = 1`,
      `DROP TRIGGER ${FOREIGN}.tr`,
      `DROP PROCEDURE ${FOREIGN}.p`,
      `DROP FUNCTION ${FOREIGN}.f`,
      `CREATE DATABASE ${FOREIGN}`,
      `ALTER DATABASE ${FOREIGN} CHARACTER SET utf8`,
      `RENAME DATABASE a TO ${FOREIGN}`,
      `CALL ${FOREIGN}.p()`,
      `DESCRIBE ${FOREIGN}.t`,
      `ANALYZE TABLE ${FOREIGN}.t`,
      `HANDLER ${FOREIGN}.t OPEN`,
      `LOAD DATA INFILE 'x' INTO TABLE ${FOREIGN}.t`,
      `INSERT INTO ${FOREIGN}.t (a) VALUES (1)`,
      `UPDATE ${FOREIGN}.t SET a = 1`,
      `DELETE FROM ${FOREIGN}.t`,
      `SELECT * FROM ${FOREIGN}.t`,
      `SELECT * FROM ${SANDBOX}.a JOIN ${FOREIGN}.b ON a.id = b.id`,
    ];
    for (const sql of statements) {
      await expectRefused(sql, 'DATABASE_NOT_ALLOWED');
    }
  });

  it('still allows the same shapes inside the sandbox', async () => {
    const statements = [
      `SELECT * FROM ${SANDBOX}.t`,
      `SELECT * FROM ${SANDBOX}.a JOIN ${SANDBOX}.b ON a.id = b.id`,
      `CREATE INDEX ix ON ${SANDBOX}.t (a)`,
      `DROP INDEX ix ON ${SANDBOX}.t`,
      `LOCK TABLES ${SANDBOX}.t READ`,
      `RENAME TABLE ${SANDBOX}.a TO ${SANDBOX}.b`,
      `INSERT INTO ${SANDBOX}.t (a) VALUES (1)`,
      `UPDATE ${SANDBOX}.t SET a = 1`,
      `DELETE FROM ${SANDBOX}.t`,
    ];
    for (const sql of statements) {
      await expectAllowed(sql);
    }
  });
});

describe('M-1: a version comment is only refused on a scoped connection', () => {
  it('allows a version comment when the profile scope is unrestricted', async () => {
    await expect(
      assertSqlScope('unrestricted-profile', 'SELECT 1 /*!50000UNION SELECT 2*/', null),
    ).resolves.toMatchObject({ mode: 'all' });
  });

  it('refuses the same version comment on a scoped connection', async () => {
    await expectRefused('SELECT 1 /*!50000UNION SELECT 2*/', 'EXECUTABLE_COMMENT_NOT_ALLOWED');
  });
});

describe('M-2: valid SQL the parser cannot read', () => {
  it('allows SET NAMES on a scoped connection', async () => {
    await expectAllowed('SET NAMES utf8');
  });

  it('allows an index hint on a scoped connection', async () => {
    await expectAllowed('SELECT * FROM orders FORCE INDEX (idx_id) WHERE id = 1');
    await expectAllowed('SELECT * FROM orders USE INDEX (idx_id) WHERE id = 1');
    await expectAllowed('SELECT * FROM orders IGNORE INDEX (idx_id) WHERE id = 1');
  });

  it('allows STRAIGHT_JOIN on a scoped connection', async () => {
    await expectAllowed('SELECT STRAIGHT_JOIN a FROM t1, t2');
  });

  it('still refuses a foreign database the parser cannot read', async () => {
    // The parser fails on the index hint, so the raw token scan has to find the
    // database reference.
    await expectRefused(
      `SELECT * FROM ${FOREIGN}.orders FORCE INDEX (idx_id)`,
      'DATABASE_NOT_ALLOWED',
    );
  });
});

describe('L-2: the SHOW scanner reads every database of the list', () => {
  it('collects every database after FROM', () => {
    const refs = collectReferencedDatabases(`SHOW TABLES FROM ${SANDBOX}, ${FOREIGN}`);
    expect(refs).toContain(SANDBOX);
    expect(refs).toContain(FOREIGN);
  });

  it('refuses a SHOW statement that names a second database', async () => {
    await expectRefused(`SHOW TABLES FROM ${SANDBOX}, ${FOREIGN}`, 'DATABASE_NOT_ALLOWED');
  });
});

describe('privilege statements are refused on a scoped connection', () => {
  it('refuses GRANT and REVOKE', async () => {
    await expectRefused(
      "GRANT ALL PRIVILEGES ON *.* TO 'x'@'%'",
      'PRIVILEGE_STATEMENT_NOT_ALLOWED',
    );
    await expectRefused(
      "REVOKE ALL PRIVILEGES ON *.* FROM 'x'@'%'",
      'PRIVILEGE_STATEMENT_NOT_ALLOWED',
    );
    // A GRANT that names a foreign database is refused for the same reason:
    // privilege management is server-wide, not database-scoped.
    await expectRefused(
      `GRANT SELECT ON ${FOREIGN}.* TO 'x'@'localhost'`,
      'PRIVILEGE_STATEMENT_NOT_ALLOWED',
    );
  });

  it('refuses account management', async () => {
    await expectRefused("CREATE USER 'x'@'%' IDENTIFIED BY 'p'", 'PRIVILEGE_STATEMENT_NOT_ALLOWED');
    await expectRefused("DROP USER 'x'@'%'", 'PRIVILEGE_STATEMENT_NOT_ALLOWED');
    await expectRefused("RENAME USER 'x'@'%' TO 'y'@'%'", 'PRIVILEGE_STATEMENT_NOT_ALLOWED');
    await expectRefused("SET PASSWORD FOR 'x'@'%' = 'p'", 'PRIVILEGE_STATEMENT_NOT_ALLOWED');
  });

  it('does not mistake ordinary SQL for a privilege statement', async () => {
    // A column that merely *looks* like the keyword must not be refused.
    await expectAllowed(`SELECT grant FROM ${SANDBOX}.t`);
    await expectAllowed(`CREATE TABLE ${SANDBOX}.t (grant INT)`);
    await expectAllowed(`SET autocommit = 1`);
    await expectAllowed(`SELECT COUNT(*) FROM ${SANDBOX}.t`);
  });
});
