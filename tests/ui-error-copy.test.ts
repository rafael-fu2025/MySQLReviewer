import { describe, expect, it } from 'vitest';
import { mapDbError } from '../server/errors';

/**
 * D-03 — a failed statement only said "The database rejected the statement."
 * and printed the raw MySQL code, so the user had no idea what to change.
 *
 * The raw MySQL text still never reaches the client (it names internal
 * tables and can repeat a stored value), but the summary must now say what
 * went wrong and what to do about it.
 */
describe('database error copy', () => {
  it('tells the user an unknown column is an unknown column', () => {
    const mapped = mapDbError({
      code: 'ER_BAD_FIELD_ERROR',
      sqlMessage: "Unknown column 'CompanyName' in 'field list'",
    });
    expect(mapped.code).toBe('UNKNOWN_COLUMN');
    expect(mapped.message).toContain('Unknown column');
    expect(mapped.message).toContain('schema panel');
  });

  it('points at the schema panel without naming the column', () => {
    const mapped = mapDbError({
      code: 'ER_BAD_FIELD_ERROR',
      sqlMessage: "Unknown column 'CompanyName' in 'field list'",
    });
    // The column name is safe to omit, but the raw server text is not
    // returned either.
    expect(mapped.message).not.toContain('CompanyName');
    expect(mapped.message).not.toContain('field list');
  });

  it('explains a foreign key that points nowhere', () => {
    const mapped = mapDbError({ code: 'ER_NO_REFERENCED_ROW_2' });
    expect(mapped.code).toBe('FOREIGN_KEY_MISSING');
    expect(mapped.message).toContain('foreign key');
  });

  it('explains a row that is still referenced', () => {
    const mapped = mapDbError({ code: 'ER_ROW_IS_REFERENCED_2' });
    expect(mapped.code).toBe('ROW_IN_USE');
    expect(mapped.message).toContain('referenced');
  });

  it('explains a value that is too long for its column', () => {
    const mapped = mapDbError({ code: 'ER_DATA_TOO_LONG' });
    expect(mapped.code).toBe('VALUE_TOO_LONG');
    expect(mapped.message).toContain('longer');
  });

  it('explains a deadlock', () => {
    const mapped = mapDbError({ code: 'ER_LOCK_DEADLOCK' });
    expect(mapped.code).toBe('DEADLOCK');
    expect(mapped.message).toContain('again');
  });

  it('keeps the MySQL error code in the details for support', () => {
    const mapped = mapDbError({ code: 'ER_BAD_FIELD_ERROR' });
    expect(mapped.details).toEqual({ code: 'ER_BAD_FIELD_ERROR' });
  });

  it('falls back to the fixed message for a code it cannot explain', () => {
    const mapped = mapDbError({ code: 'ER_SOMETHING_ELSE' });
    expect(mapped.code).toBe('MYSQL_ERROR');
    expect(mapped.message).toBe('The database rejected the statement.');
  });
});
