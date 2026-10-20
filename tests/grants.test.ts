import { describe, expect, it } from 'vitest';
import { generateGrantSql } from '../server/db/grants';

describe('least-privilege grant SQL', () => {
  it('generates reviewable SQL without executing anything', () => {
    const result = generateGrantSql({
      user: 'mylens_app',
      host: 'localhost',
      databases: ['shop'],
      privileges: ['SELECT', 'SHOW VIEW'],
    });
    expect(result.sql).toContain('CREATE USER IF NOT EXISTS');
    expect(result.sql).toContain('GRANT SELECT, SHOW VIEW ON `shop`.*');
    expect(result.sql).toContain("'mylens_app'@'localhost'");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('allows a wildcard database only when explicitly requested', () => {
    const result = generateGrantSql({
      user: 'reporting',
      databases: ['*'],
      privileges: ['SELECT'],
    });
    expect(result.sql).toContain('ON *.*');
  });

  it('rejects unsafe identifiers', () => {
    expect(() =>
      generateGrantSql({ user: "bad'user", databases: ['shop'] }),
    ).toThrow(/User name/);
    expect(() =>
      generateGrantSql({ user: 'app', databases: ['bad`name'] }),
    ).toThrow(/Invalid database name/);
    expect(() =>
      generateGrantSql({ user: 'app', databases: [] }),
    ).toThrow(/at least one database/);
  });

  it('rejects privileges outside the allowlist', () => {
    expect(() =>
      generateGrantSql({
        user: 'app',
        databases: ['shop'],
        privileges: ['SUPER'],
      }),
    ).toThrow(/Unsupported privilege/);
  });
});
