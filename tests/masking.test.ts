import { describe, expect, it } from 'vitest';
import type { QueryColumn } from '../shared/types';
import { isSensitiveColumn, maskResultRows } from '../server/db/masking';

function column(name: string, originalName = name): QueryColumn {
  return {
    name,
    originalName,
    table: 'users',
    database: 'shop',
    typeName: 'VARBINARY',
    typeCode: 253,
    flags: 0,
  };
}

describe('sensitive data masking', () => {
  it('detects credential-like column names', () => {
    expect(isSensitiveColumn('password')).toBe(true);
    expect(isSensitiveColumn('password_hash')).toBe(true);
    expect(isSensitiveColumn('user_password')).toBe(true);
    expect(isSensitiveColumn('apiKey')).toBe(true);
    expect(isSensitiveColumn('access_token')).toBe(true);
    expect(isSensitiveColumn('credit_card')).toBe(true);
    expect(isSensitiveColumn('display_name')).toBe(false);
  });

  it('masks matching cells and preserves null/empty values', () => {
    const columns = [
      column('display_name'),
      column('password_hash'),
      column('api_key'),
      column('total'),
    ];
    const rows = [
      ['Alice', 'hash-value', 'secret-key', 42],
      [null, '', '', 7],
    ];
    const masked = maskResultRows(columns, rows, { enabled: true, reveal: false });
    expect(masked.masked).toBe(true);
    expect(masked.columns[1].sensitive).toBe(true);
    expect(masked.columns[2].sensitive).toBe(true);
    expect(masked.columns[0].sensitive).toBe(false);
    expect(masked.rows[0][0]).toBe('Alice');
    expect(masked.rows[0][1]).toBe('••••••••');
    expect(masked.rows[0][2]).toBe('••••••••');
    expect(masked.rows[0][3]).toBe(42);
    expect(masked.rows[1][1]).toBe('');
    expect(masked.rows[1][2]).toBe('');
  });

  it('uses the original column name for aliases', () => {
    const masked = maskResultRows([column('p', 'password')], [['hash']], {
      enabled: true,
      reveal: false,
    });
    expect(masked.columns[0].sensitive).toBe(true);
    expect(masked.rows[0][0]).toBe('••••••••');
  });

  it('does not mask when disabled or revealed', () => {
    const disabled = maskResultRows([column('password')], [['hash']], {
      enabled: false,
      reveal: false,
    });
    expect(disabled.masked).toBe(false);
    expect(disabled.rows[0][0]).toBe('hash');

    const revealed = maskResultRows([column('password')], [['hash']], {
      enabled: true,
      reveal: true,
    });
    expect(revealed.masked).toBe(false);
    expect(revealed.rows[0][0]).toBe('hash');
  });
});
