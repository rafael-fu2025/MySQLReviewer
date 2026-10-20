import { describe, expect, it } from 'vitest';
import {
  estimateBytes,
  mysqlTypeName,
  serializeCell,
} from '../server/db/serialize';

describe('value serialization', () => {
  it('serializes dates as ISO strings', () => {
    expect(serializeCell(new Date('2024-01-02T03:04:05.000Z'), 100)).toBe(
      '2024-01-02T03:04:05.000Z',
    );
  });

  it('serializes buffers as binary previews', () => {
    const value = serializeCell(Buffer.from([0xde, 0xad, 0xbe, 0xef]), 100);
    expect(value).toMatchObject({
      __type: 'binary',
      length: 4,
      truncated: false,
    });
  });

  it('truncates long strings', () => {
    const value = serializeCell('x'.repeat(200), 10);
    expect(typeof value).toBe('string');
    expect(String(value)).toContain('truncated 190 characters');
  });

  it('serializes bigint as a string', () => {
    expect(serializeCell(BigInt('9007199254740993'), 100)).toBe(
      '9007199254740993',
    );
  });

  it('maps MySQL type codes', () => {
    expect(mysqlTypeName(3)).toBe('INT');
    expect(mysqlTypeName(245)).toBe('JSON');
    expect(mysqlTypeName(999)).toBe('TYPE_999');
  });

  it('estimates payload bytes', () => {
    expect(estimateBytes({ a: 1 })).toBeGreaterThan(0);
  });
});
