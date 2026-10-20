import { describe, expect, it } from 'vitest';
import { classifySql, classifyStatement } from '../server/review/sql-classifier';
import { splitStatements, tokenize } from '../server/review/tokenizer';

describe('tokenizer', () => {
  it('ignores semicolons inside strings and comments', () => {
    const statements = splitStatements(
      "SELECT ';' AS value; -- trailing ;\nSELECT 2 /* ; */;",
    );
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("SELECT ';'");
    expect(statements[1].sql).toContain('SELECT 2');
  });

  it('tracks line numbers and quoted identifiers', () => {
    const tokens = tokenize('SELECT\n  `odd name`\nFROM t');
    const identifier = tokens.find((token) => token.value === 'odd name');
    expect(identifier?.line).toBe(2);
    expect(identifier?.quoted).toBe(true);
  });

  it('handles comments and doubled quotes', () => {
    const tokens = tokenize("SELECT 'it''s', 1 # comment\nFROM t");
    expect(tokens.some((token) => token.kind === 'comment')).toBe(true);
    expect(tokens.find((token) => token.kind === 'string')?.value).toBe("it's");
  });
});

describe('SQL classifier', () => {
  it('classifies reads', () => {
    const result = classifyStatement('SELECT 1');
    expect(result.kind).toBe('read');
    expect(result.readOnly).toBe(true);
    expect(result.needsUnlock).toBe(false);
  });

  it('classifies DML and destructive statements', () => {
    expect(classifyStatement('DELETE FROM users')).toMatchObject({
      kind: 'write',
      destructive: true,
      needsUnlock: true,
    });
    expect(classifyStatement('UPDATE users SET name = 1 WHERE id = 2')).toMatchObject({
      kind: 'write',
      destructive: true,
      needsUnlock: true,
    });
    expect(classifyStatement('INSERT INTO t VALUES (1)')).toMatchObject({
      kind: 'write',
      destructive: false,
      needsUnlock: true,
    });
  });

  it('classifies DDL and admin statements', () => {
    expect(classifyStatement('DROP TABLE t')).toMatchObject({
      kind: 'ddl',
      destructive: true,
      needsUnlock: true,
    });
    expect(classifyStatement('CREATE TABLE t (id INT)')).toMatchObject({
      kind: 'ddl',
      destructive: false,
      needsUnlock: true,
    });
    expect(classifyStatement('USE shop')).toMatchObject({ kind: 'admin', needsUnlock: true });
  });

  it('understands EXPLAIN and EXPLAIN ANALYZE', () => {
    const plain = classifyStatement('EXPLAIN SELECT * FROM t');
    expect(plain.kind).toBe('read');
    expect(plain.readOnly).toBe(true);
    expect(plain.executesQuery).toBe(false);
    expect(plain.needsUnlock).toBe(false);

    const analyzed = classifyStatement('EXPLAIN ANALYZE SELECT * FROM t');
    expect(analyzed.executesQuery).toBe(true);
    expect(analyzed.needsUnlock).toBe(false);

    const analyzedWrite = classifyStatement('EXPLAIN ANALYZE DELETE FROM t');
    expect(analyzedWrite.kind).toBe('write');
    expect(analyzedWrite.needsUnlock).toBe(true);
  });

  it('understands CTEs', () => {
    expect(classifyStatement('WITH x AS (SELECT 1) SELECT * FROM x').kind).toBe('read');
    expect(classifyStatement('WITH x AS (SELECT 1) UPDATE t SET a = 1').kind).toBe('write');
  });

  it('flags locking reads', () => {
    const result = classifyStatement('SELECT * FROM t FOR UPDATE');
    expect(result.kind).toBe('read');
    expect(result.lockRead).toBe(true);
    expect(result.needsUnlock).toBe(true);
  });

  it('detects multiple statements', () => {
    const result = classifySql('SELECT 1; DELETE FROM t;');
    expect(result.multiStatement).toBe(true);
    expect(result.statements).toHaveLength(2);
    expect(result.overall.kind).toBe('write');
    expect(result.overall.needsUnlock).toBe(true);
  });

  it('treats empty input as empty', () => {
    expect(classifySql('   -- nothing\n').empty).toBe(true);
    expect(classifySql('').overall.needsUnlock).toBe(false);
  });
});
