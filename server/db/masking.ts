import type { CellValue, QueryColumn } from '../../shared/types';

const SENSITIVE_PATTERNS = [
  /(^|_)(password|passwd|pwd)($|_)/i,
  /(^|_)(secret|token|api_?key|private_?key|authorization)($|_)/i,
  /(^|_)(session_?id|credit_?card|ssn)($|_)/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /api_?key/i,
  /private_?key/i,
  /access_?token/i,
  /refresh_?token/i,
  /auth_?token/i,
  /authorization/i,
  /credit_?card/i,
  /(^|_)ssn($|_)/i,
  /(^|_)cvv($|_)/i,
];

export function isSensitiveColumn(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function maskCell(value: CellValue): CellValue {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' && value.length === 0) return value;
  if (typeof value === 'object' && value !== null && '__type' in value) {
    const binary = value as { length?: number };
    return `••••••••${binary.length ? ` (${binary.length} bytes)` : ''}`;
  }
  return '••••••••';
}

export function maskResultRows(
  columns: QueryColumn[],
  rows: CellValue[][],
  options: { enabled: boolean; reveal: boolean },
): { rows: CellValue[][]; columns: QueryColumn[]; masked: boolean } {
  const marked = columns.map((column) => ({
    ...column,
    sensitive:
      column.sensitive || isSensitiveColumn(column.name) || isSensitiveColumn(column.originalName),
  }));

  if (!options.enabled || options.reveal) {
    return { rows, columns: marked, masked: false };
  }

  let masked = false;
  const sensitiveIndexes = new Set<number>();
  marked.forEach((column, index) => {
    if (column.sensitive) sensitiveIndexes.add(index);
  });
  if (sensitiveIndexes.size === 0) {
    return { rows, columns: marked, masked: false };
  }

  const nextRows = rows.map((row) =>
    row.map((cell, index) => {
      if (!sensitiveIndexes.has(index)) return cell;
      if (cell === null || cell === undefined || cell === '') return cell;
      masked = true;
      return maskCell(cell);
    }),
  );
  return { rows: nextRows, columns: marked, masked };
}
