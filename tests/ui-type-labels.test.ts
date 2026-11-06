import { describe, expect, it } from 'vitest';
import { mysqlTypeName } from '../server/db/serialize';

/**
 * D-02 — the results grid labelled every VARCHAR column "VARBINARY".
 *
 * The MySQL protocol reports both `VARCHAR` and `VARBINARY` columns with the
 * type code 253 (`MYSQL_TYPE_VAR_STRING`); only the binary charset flag in
 * the column flags separates them. Mapping 253 to "VARBINARY" therefore
 * mislabelled every string column in the product.
 */
describe('mysqlTypeName', () => {
  it('names the protocol code for VARCHAR', () => {
    expect(mysqlTypeName(253)).toBe('VARCHAR');
  });

  it('still names a genuinely binary column VARBINARY', () => {
    // MySQL's BINARY_FLAG (128) marks a column whose charset is binary.
    expect(mysqlTypeName(253, 128)).toBe('VARBINARY');
  });

  it('keeps CHAR on 254', () => {
    expect(mysqlTypeName(254)).toBe('CHAR');
  });

  it('keeps the integer types', () => {
    expect(mysqlTypeName(3)).toBe('INT');
    expect(mysqlTypeName(8)).toBe('BIGINT');
  });

  it('falls back for an unknown code', () => {
    expect(mysqlTypeName(999)).toBe('TYPE_999');
  });
});
