import { describe, expect, it } from 'vitest';
import type { QueryColumn } from '../shared/types';
import { maskResultRows } from '../server/db/masking';

/**
 * H-1 — the source-aware analysis used to look at the first top-level SELECT
 * list only. A derived table in the FROM clause, a CTE body and a second
 * UNION branch were never visited, so a secret behind an alias came back in
 * cleartext. These tests pin every shape down.
 *
 * `northwind_1.Shippers.Phone` is the sensitive source column used
 * throughout: the output column is called `x` so that only the *source* can
 * tell that the value is a secret.
 */

const SECRET = '(503) 555-9831';

function column(name: string, originalName = name): QueryColumn {
  return {
    name,
    originalName,
    table: 'Shippers',
    database: 'northwind_1',
    typeName: 'VARCHAR',
    typeCode: 253,
    flags: 0,
  };
}

function masked(sql: string, columns: QueryColumn[], values: string[] = [SECRET]) {
  return maskResultRows(columns, [values], {
    enabled: true,
    reveal: false,
    sql,
  });
}

describe('H-1 — a secret behind a derived table stays masked', () => {
  it('masks a plain sensitive column', () => {
    const result = masked('SELECT Phone FROM Shippers', [column('Phone')]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks an aliased sensitive column', () => {
    const result = masked('SELECT Phone AS x FROM Shippers', [column('x', '')]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks an expression that reads a sensitive column', () => {
    const result = masked('SELECT CONCAT(Phone) AS x FROM Shippers', [column('x', '')]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a column read through a derived table in the FROM clause', () => {
    const result = masked('SELECT x FROM (SELECT Phone AS x FROM Shippers) d', [column('x', '')]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks an expression inside a derived table', () => {
    const result = masked('SELECT x FROM (SELECT CONCAT(Phone) AS x FROM Shippers) d', [
      column('x', ''),
    ]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a star over a derived table', () => {
    const result = masked('SELECT * FROM (SELECT Phone AS x FROM Shippers) d', [column('x', '')]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a qualified reference to a derived table', () => {
    const result = masked('SELECT d.x FROM (SELECT Phone AS x FROM Shippers) d', [column('x', '')]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a nested derived table', () => {
    const result = masked('SELECT y FROM (SELECT x FROM (SELECT Phone AS x FROM Shippers) a) b', [
      column('y', ''),
    ]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a scalar sub-query', () => {
    const result = masked('SELECT (SELECT Phone FROM Shippers) AS x', [column('x', '')]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });
});

describe('H-1 — a secret behind a CTE stays masked', () => {
  it('masks a column read through a CTE', () => {
    const result = masked('WITH cte AS (SELECT Phone AS x FROM Shippers) SELECT x FROM cte', [
      column('x', ''),
    ]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a star over a CTE', () => {
    const result = masked('WITH cte AS (SELECT Phone AS x FROM Shippers) SELECT * FROM cte', [
      column('x', ''),
    ]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a CTE with an explicit column list', () => {
    const result = masked('WITH cte (x) AS (SELECT Phone FROM Shippers) SELECT x FROM cte', [
      column('x', ''),
    ]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });
});

describe('H-1 — a secret in a UNION branch stays masked', () => {
  it('masks a UNION whose second branch carries the secret', () => {
    const result = masked("SELECT 'redacted' AS x UNION SELECT Phone AS x FROM Shippers", [
      column('x', ''),
    ]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });

  it('masks a UNION ALL whose second branch carries the secret', () => {
    const result = masked("SELECT 'redacted' AS x UNION ALL SELECT Phone AS x FROM Shippers", [
      column('x', ''),
    ]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });
});

describe('H-1 — the analysis fails closed when it cannot resolve a source', () => {
  it('masks every column when a star spans a table and a derived table', () => {
    const result = masked(
      'SELECT * FROM Shippers s JOIN (SELECT Phone AS x FROM Shippers) d ON s.ShipperID = d.x',
      [column('ShipperID'), column('x', '')],
      ['1', SECRET],
    );
    expect(result.columns.every((entry) => entry.sensitive)).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
    expect(result.rows[0][1]).toBe('••••••••');
  });

  it('masks every column when the parser cannot model the statement', () => {
    // `PROCEDURE analyse()` is not modelled by the parser, so the output
    // columns of the derived table cannot be traced.
    const result = masked('SELECT x FROM (SELECT Phone AS x FROM Shippers) d PROCEDURE analyse()', [
      column('x', ''),
    ]);
    expect(result.columns[0].sensitive).toBe(true);
    expect(result.rows[0][0]).toBe('••••••••');
  });
});

describe('H-1 — ordinary columns are not masked', () => {
  it('does not mask an expression over ordinary columns', () => {
    const result = masked(
      'SELECT CONCAT(ShipperName, " (", ShipperID, ")") AS label FROM Shippers',
      [column('label', '')],
      ['Speedy Express (1)'],
    );
    expect(result.columns[0].sensitive).toBe(false);
    expect(result.rows[0][0]).toBe('Speedy Express (1)');
  });

  it('does not mask a count', () => {
    const result = masked('SELECT COUNT(*) AS n FROM Shippers', [column('n', '')], ['3']);
    expect(result.columns[0].sensitive).toBe(false);
    expect(result.rows[0][0]).toBe('3');
  });

  it('does not mask a column read through a derived table of ordinary columns', () => {
    const result = masked(
      'SELECT x FROM (SELECT ShipperName AS x FROM Shippers) d',
      [column('x', '')],
      ['Speedy Express'],
    );
    expect(result.columns[0].sensitive).toBe(false);
    expect(result.rows[0][0]).toBe('Speedy Express');
  });

  it('does not mask a column read through a CTE of ordinary columns', () => {
    const result = masked(
      'WITH cte AS (SELECT ShipperName AS x FROM Shippers) SELECT x FROM cte',
      [column('x', '')],
      ['Speedy Express'],
    );
    expect(result.columns[0].sensitive).toBe(false);
    expect(result.rows[0][0]).toBe('Speedy Express');
  });

  it('does not mask a star over a plain table', () => {
    const result = masked(
      'SELECT * FROM Shippers',
      [column('ShipperID'), column('ShipperName')],
      ['1', 'Speedy Express'],
    );
    expect(result.columns.every((entry) => entry.sensitive)).toBe(false);
    expect(result.rows[0][1]).toBe('Speedy Express');
  });
});
