import { describe, expect, it } from 'vitest';
import { runStaticReview } from '../server/review/static-review';

async function ruleIds(sql: string): Promise<string[]> {
  const result = await runStaticReview({
    sql,
    includeSchema: false,
    includeExplain: false,
  });
  return result.findings.map((finding) => finding.ruleId);
}

describe('static review rules', () => {
  it('flags DELETE without WHERE', async () => {
    expect(await ruleIds('DELETE FROM users')).toContain('sql.delete-without-where');
  });

  it('flags UPDATE without WHERE', async () => {
    expect(await ruleIds('UPDATE users SET active = 0')).toContain('sql.update-without-where');
  });

  it('flags NULL equality and random sorting', async () => {
    const ids = await ruleIds(
      'SELECT * FROM users WHERE id = NULL ORDER BY RAND() LIMIT 5 OFFSET 2000',
    );
    expect(ids).toContain('sql.null-equality');
    expect(ids).toContain('sql.order-by-rand');
    expect(ids).toContain('sql.large-offset');
    expect(ids).toContain('sql.select-star');
  });

  it('flags implicit cross joins', async () => {
    expect(await ruleIds('SELECT * FROM a, b')).toContain('sql.cartesian-join');
  });

  it('flags INSERT without a column list', async () => {
    expect(await ruleIds('INSERT INTO t VALUES (1, 2)')).toContain('sql.insert-without-columns');
  });

  it('flags leading wildcard LIKE', async () => {
    expect(await ruleIds("SELECT id FROM t WHERE name LIKE '%bob%'")).toContain(
      'sql.leading-wildcard',
    );
  });

  it('flags multiple statements', async () => {
    expect(await ruleIds('SELECT 1; DELETE FROM t;')).toContain('sql.multi-statement');
  });

  it('does not flag a clean bounded query', async () => {
    const ids = await ruleIds('SELECT id FROM t WHERE id = 1 LIMIT 1');
    expect(ids).not.toContain('sql.select-star');
    expect(ids).not.toContain('sql.select-without-limit');
    expect(ids).not.toContain('sql.delete-without-where');
  });

  it('produces a score with counts', async () => {
    const result = await runStaticReview({
      sql: 'DELETE FROM users',
      includeSchema: false,
    });
    expect(result.score.counts.critical).toBeGreaterThanOrEqual(1);
    expect(result.score.grade).toBe('C');
    expect(result.score.score).toBeLessThan(80);
  });
});
