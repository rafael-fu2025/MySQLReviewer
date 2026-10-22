import type { BinaryCell, CellValue } from '../../shared/types';

const TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'DATE',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VARBINARY',
  254: 'CHAR',
  255: 'GEOMETRY',
};

export function mysqlTypeName(code: number): string {
  return TYPE_NAMES[code] ?? `TYPE_${code}`;
}

export function serializeBinary(buffer: Buffer): BinaryCell {
  const preview = buffer.subarray(0, 256);
  return {
    __type: 'binary',
    length: buffer.length,
    previewHex: preview
      .toString('hex')
      .replace(/(.{2})/g, '$1 ')
      .trim(),
    truncated: buffer.length > preview.length,
  };
}

export function serializeCell(value: unknown, maxChars: number): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxChars) {
      const truncated = value.slice(0, maxChars);
      return `${truncated}\n… [truncated ${value.length - truncated.length} characters]`;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '0000-00-00 00:00:00' : value.toISOString();
  }
  if (Buffer.isBuffer(value)) return serializeBinary(value);
  if (typeof value === 'object') return value as Record<string, unknown>;
  return String(value);
}

export function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}
