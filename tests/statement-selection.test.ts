import { describe, expect, it } from 'vitest';

import { classifySql } from '../server/review/sql-classifier';
import { statementAtOffset } from '../server/db/query';

/**
 * A script may hold several statements, but only one of them may be sent to
 * the server in a single command. The caret says which one the user means.
 */
describe('the statement under the caret', () => {
  const script = 'INSERT INTO t (id) VALUES (1);\nSELECT COUNT(*) FROM t;';

  it('finds the statement the caret is inside', () => {
    const statements = classifySql(script).statements;
    const inside = statementAtOffset(statements, script.indexOf('SELECT') + 2);
    expect(inside?.sql).toBe('SELECT COUNT(*) FROM t');
  });

  it('finds the first statement when the caret is in it', () => {
    const statements = classifySql(script).statements;
    const inside = statementAtOffset(statements, script.indexOf('INSERT') + 2);
    expect(inside?.sql).toBe('INSERT INTO t (id) VALUES (1)');
  });

  it('finds the next statement when the caret sits just after a terminator', () => {
    const statements = classifySql(script).statements;
    const inside = statementAtOffset(statements, script.indexOf(';') + 1);
    expect(inside?.sql).toBe('SELECT COUNT(*) FROM t');
  });

  it('falls back to the last statement when the caret is past the end', () => {
    const statements = classifySql(script).statements;
    const inside = statementAtOffset(statements, script.length);
    expect(inside?.sql).toBe('SELECT COUNT(*) FROM t');
  });

  it('returns nothing when there is no caret', () => {
    const statements = classifySql(script).statements;
    expect(statementAtOffset(statements, undefined)).toBeNull();
  });

  it('returns nothing for a caret before the script', () => {
    const statements = classifySql(script).statements;
    expect(statementAtOffset(statements, -1)).toBeNull();
  });

  it('carries the classification of the statement it picked', () => {
    const statements = classifySql(script).statements;
    const inside = statementAtOffset(statements, script.indexOf('INSERT') + 2);
    // The INSERT is a write, the SELECT is a read: the gate must see the one
    // that actually runs, not a merge of both.
    expect(inside?.classification.kind).toBe('write');
    const read = statementAtOffset(statements, script.indexOf('SELECT') + 2);
    expect(read?.classification.kind).toBe('read');
  });
});
