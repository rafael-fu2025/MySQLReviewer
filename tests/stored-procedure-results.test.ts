import { describe, expect, it } from 'vitest';

import { normaliseStatementResult } from '../server/db/query';

/**
 * A stored procedure answers with several results: the CALL itself replies
 * with an OK packet and the procedure's result set follows it. mysql2 hands
 * that back as a list, which is a different shape from a plain statement.
 */
const field = (name: string) => ({ name }) as unknown as never;

describe('normaliseStatementResult', () => {
  it('reads a plain result set', () => {
    const result = normaliseStatementResult(
      [
        [1, 'a'],
        [2, 'b'],
      ],
      [field('id'), field('name')],
    );
    expect(result.rows).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'name']);
    expect(result.header).toBeNull();
  });

  it('reads a plain result header', () => {
    const header = { affectedRows: 3, insertId: 7, info: 'Records: 3' };
    const result = normaliseStatementResult(header, undefined);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.header).toBe(header);
  });

  it('reads the result set of a procedure that returns rows', () => {
    // The shape mysql2 produces for `CALL p()`: the rows are the first
    // result, the field list of that result is the first entry of `fields`,
    // and the OK packet of the call itself follows.
    const result = normaliseStatementResult(
      [
        [
          [1, 'a'],
          [2, 'b'],
        ],
        { affectedRows: 0, insertId: 0, info: '' },
      ],
      [[field('id'), field('name')], undefined],
    );
    expect(result.rows).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'name']);
  });

  it('reads the result set of a procedure that returns one row', () => {
    const result = normaliseStatementResult([[[42]]], [[field('answer')]]);
    expect(result.rows).toEqual([[42]]);
    expect(result.columns.map((column) => column.name)).toEqual(['answer']);
  });

  it('reports a procedure that returns no result set', () => {
    const result = normaliseStatementResult({ affectedRows: 0, insertId: 0, info: '' }, undefined);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
  });

  it('does not crash on an undefined field', () => {
    // A missing field must not take the whole result down.
    const result = normaliseStatementResult([[1]], [undefined]);
    expect(result.columns[0].name).toBe('');
  });

  it('picks the first result that carries rows when a procedure returns several', () => {
    const result = normaliseStatementResult(
      [[['first']], [['second']], { affectedRows: 0 }],
      [[field('a')], [field('b')], undefined],
    );
    expect(result.rows).toEqual([['first']]);
    expect(result.columns.map((column) => column.name)).toEqual(['a']);
  });
});
