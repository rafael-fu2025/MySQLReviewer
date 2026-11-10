import { describe, expect, it } from 'vitest';

import {
  buildCreateEvent,
  isSessionStatement,
  keysetPageQuery,
  looksLikeCompoundStatement,
  orderByForeignKey,
  pickUsableKey,
  previewImportScript,
  sendableStatementText,
  sqlLiteral,
  stripDefiner,
  type ExportEventRow,
  type KeyCandidate,
} from '../server/db/import-export';
import type { TableSummary } from '../shared/types';

const table = (name: string): TableSummary =>
  ({
    database: 'db',
    name,
    type: 'BASE TABLE',
    engine: 'InnoDB',
    rowsEstimate: 0,
    dataBytes: 0,
    indexBytes: 0,
    collation: null,
    comment: '',
  }) as TableSummary;

describe('orderByForeignKey', () => {
  it('puts a parent table before the table that points at it', () => {
    const edges = new Map([['attendances', new Set(['events'])]]);
    const ordered = orderByForeignKey([table('attendances'), table('events')], edges);
    expect(ordered.map((t) => t.name)).toEqual(['events', 'attendances']);
  });

  it('keeps a chain in order', () => {
    const edges = new Map([
      ['c', new Set(['b'])],
      ['b', new Set(['a'])],
    ]);
    const ordered = orderByForeignKey([table('c'), table('b'), table('a')], edges);
    expect(ordered.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('leaves tables without foreign keys in their original order', () => {
    const ordered = orderByForeignKey([table('a'), table('b')], new Map());
    expect(ordered.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('does not loop forever on a cycle', () => {
    const edges = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['a'])],
    ]);
    const ordered = orderByForeignKey([table('a'), table('b')], edges);
    expect(ordered).toHaveLength(2);
  });

  it('ignores a parent that is not part of the dump', () => {
    const edges = new Map([['a', new Set(['missing'])]]);
    const ordered = orderByForeignKey([table('a')], edges);
    expect(ordered.map((t) => t.name)).toEqual(['a']);
  });
});

describe('sqlLiteral', () => {
  it('renders the simple values', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral(1.5)).toBe('1.5');
    expect(sqlLiteral(true)).toBe('1');
    expect(sqlLiteral(false)).toBe('0');
  });

  it('quotes a string and doubles the quote inside it', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it('doubles a backslash, so the value survives the default SQL mode', () => {
    expect(sqlLiteral('a\\b')).toBe("'a\\\\b'");
  });

  it('escapes the control characters that would end the literal', () => {
    expect(sqlLiteral('a\nb')).toBe("'a\\nb'");
    expect(sqlLiteral('a\rb')).toBe("'a\\rb'");
    expect(sqlLiteral('a\0b')).toBe("'a\\0b'");
  });

  it('renders a binary value as a hex literal', () => {
    expect(sqlLiteral(Buffer.from([0x00, 0xff]))).toBe("X'00ff'");
  });
});

describe('stripDefiner', () => {
  it('removes the definer clause of a routine', () => {
    const sql = 'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() BEGIN SELECT 1; END';
    expect(stripDefiner(sql)).toBe('CREATE PROCEDURE `p`() BEGIN SELECT 1; END');
  });

  it('removes a quoted definer too', () => {
    const sql = "CREATE DEFINER='root'@'localhost' FUNCTION `f`() RETURNS INT RETURN 1";
    expect(stripDefiner(sql)).toBe('CREATE FUNCTION `f`() RETURNS INT RETURN 1');
  });

  it('keeps the SQL SECURITY DEFINER clause, which is a different clause', () => {
    const sql =
      'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1';
    const stripped = stripDefiner(sql);
    expect(stripped).not.toContain('DEFINER=`root`');
    expect(stripped).not.toContain('@`localhost`');
    expect(stripped).toContain('SQL SECURITY DEFINER');
  });
});

describe('looksLikeCompoundStatement', () => {
  it('recognises a routine body', () => {
    expect(looksLikeCompoundStatement('CREATE PROCEDURE p() BEGIN SELECT 1; END')).toBe(true);
  });

  it('does not mistake an ordinary statement for one', () => {
    expect(looksLikeCompoundStatement('SELECT * FROM t')).toBe(false);
    expect(looksLikeCompoundStatement('CREATE TABLE t (a INT)')).toBe(false);
    expect(looksLikeCompoundStatement('SELECT CASE WHEN a THEN 1 END FROM t')).toBe(false);
  });
});

describe('sendableStatementText', () => {
  it('leaves an ordinary statement alone', () => {
    expect(sendableStatementText('SELECT 1')).toBe('SELECT 1');
  });

  it('wraps a routine so its body stays one statement', () => {
    const sent = sendableStatementText('CREATE PROCEDURE p() BEGIN SELECT 1; END');
    expect(sent.startsWith('DELIMITER ;;')).toBe(true);
    expect(sent.endsWith(';;')).toBe(true);
    expect(sent).toContain('CREATE PROCEDURE p() BEGIN SELECT 1; END');
  });

  it('moves the terminator on when the body already contains it', () => {
    const sent = sendableStatementText('CREATE PROCEDURE p() BEGIN SELECT 1;; END');
    expect(sent.startsWith('DELIMITER ;;;')).toBe(true);
  });
});

describe('isSessionStatement', () => {
  it('recognises a session variable', () => {
    expect(isSessionStatement('SET FOREIGN_KEY_CHECKS = 0;')).toBe(true);
    expect(isSessionStatement('SET @OLD_CHARACTER_SET_CLIENT = @@CHARACTER_SET_CLIENT;')).toBe(
      true,
    );
  });

  it('recognises a database switch', () => {
    expect(isSessionStatement('USE `mydb`;')).toBe(true);
  });

  it('does not treat SET PASSWORD as a session setting', () => {
    // `SET PASSWORD` changes an account, so it is a real statement.
    expect(isSessionStatement("SET PASSWORD FOR 'u'@'%' = 'p';")).toBe(false);
  });

  it('does not treat an ordinary statement as a session setting', () => {
    expect(isSessionStatement('SELECT * FROM t;')).toBe(false);
    expect(isSessionStatement('INSERT INTO t (a) VALUES (1);')).toBe(false);
    expect(isSessionStatement('SETUP_TABLE')).toBe(false);
  });

  it('treats a statement that is only a comment as a session setting', () => {
    expect(isSessionStatement('-- just a note')).toBe(true);
  });
});

describe('previewImportScript', () => {
  it('reads the statements of a script without running any of them', () => {
    const preview = previewImportScript(
      'SELECT 1;\nINSERT INTO t (a) VALUES (1);\nUPDATE t SET a = 2;',
    );
    expect(preview.statements).toHaveLength(3);
    expect(preview.statements[0].kind).toBe('read');
    expect(preview.statements[1].kind).toBe('write');
    expect(preview.statements[2].kind).toBe('write');
    expect(preview.needsUnlockCount).toBeGreaterThan(0);
  });

  it('counts the statements that destroy data', () => {
    const preview = previewImportScript('DELETE FROM t;');
    expect(preview.destructiveCount).toBe(1);
    expect(preview.statements[0].destructive).toBe(true);
  });

  it('reports a script that uses a DELIMITER directive', () => {
    expect(previewImportScript('delimiter //\nSELECT 1//').hasDelimiter).toBe(true);
    expect(previewImportScript('SELECT 1;').hasDelimiter).toBe(false);
  });

  it('splits a routine body into one statement when the directive is present', () => {
    const preview = previewImportScript(
      'delimiter //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\ndelimiter ;',
    );
    expect(preview.statements).toHaveLength(1);
    expect(preview.statements[0].sql).toContain('CREATE PROCEDURE p()');
  });

  it('re-wraps a routine so it can be sent on its own', () => {
    const preview = previewImportScript(
      'delimiter //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\ndelimiter ;',
    );
    expect(preview.statements[0].sql.startsWith('DELIMITER ;;')).toBe(true);
  });

  it('counts the bytes of the script', () => {
    expect(previewImportScript('SELECT 1;').bytes).toBe(9);
  });

  it('reports the session settings of a mysqldump-style file', () => {
    const preview = previewImportScript(
      [
        'SET @OLD_CHARACTER_SET_CLIENT = @@CHARACTER_SET_CLIENT;',
        'SET FOREIGN_KEY_CHECKS = 0;',
        'USE `mydb`;',
        'DROP TABLE IF EXISTS `t`;',
        'CREATE TABLE `t` (a INT);',
        'INSERT INTO `t` VALUES (1);',
      ].join('\n'),
    );
    expect(preview.sessionCount).toBe(3);
    // The two session settings and the USE are the session statements.
    expect(preview.statements.filter((s) => s.session)).toHaveLength(3);
    // The DROP is destructive and is named so the caller can warn about it.
    expect(preview.destructiveStatements.some((line) => line.includes('DROP TABLE'))).toBe(true);
  });
});

describe('keysetPageQuery', () => {
  it('builds a first page that is ordered but unbounded', () => {
    const page = keysetPageQuery('shop', 'orders', ['id'], null, 500);
    expect(page.sql).toBe('SELECT * FROM `shop`.`orders` ORDER BY `id` LIMIT ?');
    expect(page.values).toEqual([500]);
  });

  it('builds a keyset page with a tuple cursor on a composite key', () => {
    const page = keysetPageQuery('shop', 'order_lines', ['order_id', 'line_no'], [41, 7], 500);
    expect(page.sql).toBe(
      'SELECT * FROM `shop`.`order_lines` WHERE (`order_id`, `line_no`) > (?, ?) ORDER BY `order_id`, `line_no` LIMIT ?',
    );
    // The cursor values come first, the page size last.
    expect(page.values).toEqual([41, 7, 500]);
  });
});

describe('pickUsableKey', () => {
  const column = (
    name: string,
    overrides: Partial<{ dataType: string; nullable: boolean; prefixed: boolean }> = {},
  ) => ({ name, dataType: 'int', nullable: false, prefixed: false, ...overrides });

  const candidate = (
    name: string,
    unique: boolean,
    columns: KeyCandidate['columns'],
  ): KeyCandidate => ({
    name,
    unique,
    columns,
  });

  it('prefers the primary key', () => {
    const picked = pickUsableKey([
      candidate('idx_email', true, [column('email', { dataType: 'varchar' })]),
      candidate('PRIMARY', true, [column('id')]),
    ]);
    expect(picked).toEqual(['id']);
  });

  it('falls back to a unique secondary index when there is no primary key', () => {
    const picked = pickUsableKey([
      candidate('idx_email', true, [column('email', { dataType: 'varchar' })]),
      candidate('idx_check', false, [column('a')]),
    ]);
    expect(picked).toEqual(['email']);
  });

  it('rejects a nullable unique index', () => {
    const picked = pickUsableKey([candidate('PRIMARY', true, [column('id', { nullable: true })])]);
    expect(picked).toBeNull();
  });

  it('rejects a prefix unique index, whose values are not fully unique', () => {
    const picked = pickUsableKey([
      candidate('PRIMARY', true, [column('id')]),
      candidate('idx_url', true, [column('url', { dataType: 'varchar', prefixed: true })]),
    ]);
    expect(picked).toEqual(['id']);
  });

  it('rejects key columns of a type whose ordering is unreliable', () => {
    const picked = pickUsableKey([
      candidate('PRIMARY', true, [column('id'), column('ratio', { dataType: 'double' })]),
    ]);
    expect(picked).toBeNull();
  });

  it('returns null without any usable candidate', () => {
    expect(pickUsableKey([candidate('idx_a', false, [column('a')])])).toBeNull();
    expect(pickUsableKey([])).toBeNull();
  });
});

describe('buildCreateEvent', () => {
  const recurringRow: ExportEventRow = {
    EVENT_NAME: 'nightly_cleanup',
    EVENT_DEFINITION: 'DELETE FROM sessions WHERE expires_at < NOW()',
    EVENT_TYPE: 'RECURRING',
    INTERVAL_VALUE: '1',
    INTERVAL_FIELD: 'DAY',
    STATUS: 'ENABLED',
    ON_COMPLETION: 'NOT PRESERVE',
    STARTS: '2026-01-01 03:00:00',
    ENDS: null,
    EXECUTE_AT: null,
    EVENT_COMMENT: 'purge old sessions',
  };

  it('assembles a recurring event with schedule, completion and status', () => {
    const sql = buildCreateEvent(recurringRow);
    expect(sql).toBe(
      "CREATE EVENT `nightly_cleanup` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 03:00:00' " +
        "ON COMPLETION NOT PRESERVE ENABLE COMMENT 'purge old sessions' " +
        'DO DELETE FROM sessions WHERE expires_at < NOW()',
    );
  });

  it('never emits the definer, even though the server knows it', () => {
    // The information_schema row carries a definer; the statement is emitted
    // without one (and runs through stripDefiner at emission).
    const sql = stripDefiner(buildCreateEvent(recurringRow));
    expect(sql).not.toContain('DEFINER');
  });

  it('assembles a one-time event from EXECUTE_AT and keeps DISABLE', () => {
    const sql = buildCreateEvent({
      ...recurringRow,
      EVENT_NAME: 'one_shot',
      EVENT_TYPE: 'ONE TIME',
      INTERVAL_VALUE: null,
      INTERVAL_FIELD: null,
      STARTS: null,
      EXECUTE_AT: '2026-02-01 12:00:00',
      STATUS: 'DISABLED',
      ON_COMPLETION: 'PRESERVE',
      EVENT_COMMENT: '',
    });
    expect(sql).toBe(
      "CREATE EVENT `one_shot` ON SCHEDULE AT '2026-02-01 12:00:00' " +
        'ON COMPLETION PRESERVE DISABLE DO DELETE FROM sessions WHERE expires_at < NOW()',
    );
  });

  it('emits DISABLE ON SLAVE for an event disabled on this replica', () => {
    const sql = buildCreateEvent({ ...recurringRow, STATUS: 'SLAVESIDE_DISABLED' });
    expect(sql).toContain('DISABLE ON SLAVE');
  });

  it('omits the comment clause when the comment is empty', () => {
    const sql = buildCreateEvent({ ...recurringRow, EVENT_COMMENT: '' });
    expect(sql).not.toContain('COMMENT');
  });

  it('formats a Date column as a UTC timestamp literal', () => {
    const sql = buildCreateEvent({
      ...recurringRow,
      STARTS: new Date(Date.UTC(2026, 0, 1, 3, 0, 0)),
    });
    expect(sql).toContain("STARTS '2026-01-01 03:00:00'");
  });
});
