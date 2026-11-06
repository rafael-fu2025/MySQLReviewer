import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { QueryColumn } from '../shared/types';
import { isSensitiveColumn, maskResultRows } from '../server/db/masking';

function column(name: string, originalName = name): QueryColumn {
  return {
    name,
    originalName,
    table: 'users',
    database: 'shop',
    typeName: 'VARCHAR',
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

describe('sensitive name coverage', () => {
  it('treats common credential and PII column names as sensitive', () => {
    // Names measured as unmasked before the pattern list was extended.
    const names = [
      'passphrase',
      'card',
      'card_number',
      'cardno',
      'cc_number',
      'pan',
      'cvc',
      'social_security_number',
      'email',
      'user_email',
      'phone',
      'phone_number',
      'dob',
      'national_id',
      'otp',
      'jwt',
      'credential',
      'iban',
      'account_number',
    ];
    for (const name of names) {
      expect(isSensitiveColumn(name), name).toBe(true);
    }
  });

  it('treats the compound forms of the ambiguous words as sensitive', () => {
    // `key`, `token`, `hash`, `pin`, `tel`, `mail`, `cc` and `pw` are only
    // sensitive as a recognised compound.
    const names = [
      'api_key',
      'secret_key',
      'private_key',
      'access_key',
      'encryption_key',
      'api_token',
      'auth_token',
      'access_token',
      'refresh_token',
      'password_hash',
      'api_key_hash',
      'token_hash',
      'pin_code',
      'telephone',
      'email_address',
      'user_password',
      'passphrase',
    ];
    for (const name of names) {
      expect(isSensitiveColumn(name), name).toBe(true);
    }
  });

  it('does not treat a bare ambiguous word as sensitive', () => {
    // These words are the ones that produced the false positives: a Laravel
    // `cache.key`, a `*_key_id` foreign key, a `commit_hash` and a bare
    // `token` column.
    const names = ['key', 'keys', 'token', 'hash', 'pin', 'tel', 'mail', 'cc', 'pw', 'pass'];
    for (const name of names) {
      expect(isSensitiveColumn(name), name).toBe(false);
    }
  });

  it('does not treat an identifier that merely mentions a key or a hash as sensitive', () => {
    const names = [
      'cache.key',
      'notes_key_id',
      'key_id',
      'key_ref',
      'question_key',
      'notes_key_version',
      'payload_key_version',
      'instrument_key',
      'storage_key',
      'idempotency_key',
      'encryption_key_version_id',
      'clinical_summary_key_id',
      'team_delivery_key',
      'request_key',
      'event_key',
      'occurrence_key',
      'setting_key',
      'submission_key',
      'commit_hash',
      'user_agent_hash',
      'row_hash',
      'rules_hash',
      'bucket_hash',
      'definition_hash',
      'replaced_by_hash',
    ];
    for (const name of names) {
      expect(isSensitiveColumn(name), name).toBe(false);
    }
  });

  it('also matches camelCase spellings', () => {
    expect(isSensitiveColumn('userEmail')).toBe(true);
    expect(isSensitiveColumn('cardNumber')).toBe(true);
    expect(isSensitiveColumn('socialSecurityNumber')).toBe(true);
  });

  it('leaves ordinary columns alone', () => {
    for (const name of ['display_name', 'total', 'username', 'created_at', 'status']) {
      expect(isSensitiveColumn(name), name).toBe(false);
    }
  });
});

describe('source-aware masking', () => {
  it('masks an aliased expression that reads a sensitive column', () => {
    const masked = maskResultRows([column('x', '')], [['p@ssw0rd-REAL']], {
      enabled: true,
      reveal: false,
      sql: 'SELECT CONCAT(password) AS x FROM users',
    });
    expect(masked.columns[0].sensitive).toBe(true);
    expect(masked.rows[0][0]).toBe('••••••••');
  });

  it('masks an aggregate over a sensitive column behind an alias', () => {
    const masked = maskResultRows([column('max_pw', '')], [['p@ssw0rd-REAL']], {
      enabled: true,
      reveal: false,
      sql: 'SELECT MAX(password) AS max_pw FROM users',
    });
    expect(masked.columns[0].sensitive).toBe(true);
    expect(masked.rows[0][0]).toBe('••••••••');
  });

  it('keeps masking the unaliased expression', () => {
    const masked = maskResultRows([column('MAX(password)', '')], [['p@ssw0rd-REAL']], {
      enabled: true,
      reveal: false,
      sql: 'SELECT MAX(password) FROM users',
    });
    expect(masked.rows[0][0]).toBe('••••••••');
  });

  it('does not mask an expression over ordinary columns', () => {
    const masked = maskResultRows([column('full_name', '')], [['Alice Hidden']], {
      enabled: true,
      reveal: false,
      sql: 'SELECT CONCAT(first_name, last_name) AS full_name FROM users',
    });
    expect(masked.columns[0].sensitive).toBe(false);
    expect(masked.rows[0][0]).toBe('Alice Hidden');
  });

  it('does not mask a count', () => {
    const masked = maskResultRows([column('n', '')], [[7]], {
      enabled: true,
      reveal: false,
      sql: 'SELECT COUNT(*) AS n FROM users',
    });
    expect(masked.columns[0].sensitive).toBe(false);
    expect(masked.rows[0][0]).toBe(7);
  });
});

describe('the false-positive rate on a real schema', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  /** The column names of every table in a `CREATE TABLE` script. */
  function schemaColumns(sql: string): string[] {
    const columns: string[] = [];
    const createTable = /CREATE TABLE\s+`(\w+)`\s*\(([\s\S]*?)\n\)/g;
    let table: RegExpExecArray | null;
    while ((table = createTable.exec(sql)) !== null) {
      for (const line of table[2].split('\n')) {
        const column = /^\s*`(\w+)`\s+/.exec(line);
        if (column) columns.push(column[1]);
      }
    }
    return columns;
  }

  it('flags only the two genuinely personal columns of the Northwind schema', () => {
    const sql = readFileSync(path.join(repoRoot, 'data', 'northwind', 'northwind.sql'), 'utf8');
    const columns = schemaColumns(sql);
    expect(columns.length).toBeGreaterThan(30);

    const flagged = columns.filter((name) => isSensitiveColumn(name));
    const flaggedNames = [...new Set(flagged)];
    expect(flaggedNames.sort()).toEqual(['BirthDate', 'Phone']);
    // `Phone` exists in both `Shippers` and `Suppliers`; nothing else does.
    expect(flagged.length).toBe(3);
  });
});
