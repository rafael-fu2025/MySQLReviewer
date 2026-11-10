import type { CellValue, QueryColumn } from '@shared/types';
import { downloadText } from './api';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  // Past an hour, minutes stop being readable: an uptime of 34 hours used to
  // print as "2072m 41s". Each tier rounds once, so a carry never reaches 60.
  if (ms < 3_600_000) {
    const totalSeconds = Math.round(ms / 1000);
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  }
  if (ms < 86_400_000) {
    const totalMinutes = Math.round(ms / 60_000);
    return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
  }
  const totalHours = Math.round(ms / 3_600_000);
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function sqlPreview(sql: string, max = 90): string {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  return truncate(collapsed, max);
}

export function cellText(value: CellValue): string {
  if (value == null) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') {
    if ('__type' in value && value.__type === 'binary') {
      return `0x${String((value as { previewHex?: string }).previewHex ?? '')} (${(value as { length?: number }).length ?? 0} bytes)`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function csvEscape(value: CellValue): string {
  const text = cellText(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(columns: QueryColumn[], rows: CellValue[][]): string {
  const header = columns.map((column) => csvEscape(column.name)).join(',');
  const body = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  return `\uFEFF${header}\n${body}`;
}

export function downloadCsv(filename: string, columns: QueryColumn[], rows: CellValue[][]): void {
  downloadText(filename, toCsv(columns, rows), 'text/csv;charset=utf-8');
}

/* ------------------------------------------------------------------ */
/* Copy-as formats                                                     */
/* ------------------------------------------------------------------ */

/**
 * Tab-separated values with a header row. A value can never break out of its
 * cell: backslashes and control characters are escaped as backslash
 * sequences (`\\`, `\t`, `\r`, `\n`) rather than written literally.
 */
function tsvEscape(value: CellValue): string {
  return cellText(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export function toTsv(columns: QueryColumn[], rows: CellValue[][]): string {
  const header = columns.map((column) => tsvEscape(column.name)).join('\t');
  const body = rows.map((row) => row.map(tsvEscape).join('\t')).join('\n');
  return `${header}\n${body}`;
}

/**
 * Markdown table cells: a literal `|` would end the cell, and a raw newline
 * would end the row, so pipes are backslash-escaped and newlines become
 * `<br>`.
 */
function markdownCell(value: CellValue): string {
  return cellText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function toMarkdownTable(columns: QueryColumn[], rows: CellValue[][]): string {
  const header = `| ${columns.map((column) => markdownCell(column.name)).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`).join('\n');
  return [header, divider, body].join('\n');
}

/** The table a result came from, when every column agrees on one. */
export function sqlInsertTarget(
  columns: QueryColumn[],
): { database: string | null; table: string } | null {
  const named = columns.find((column) => column.table);
  if (!named?.table) return null;
  return { database: named.database ?? null, table: named.table };
}

function sqlIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function sqlString(text: string): string {
  // Backslashes are escape characters on MySQL's default sql_mode, so they
  // are doubled alongside the quotes.
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function sqlValue(value: CellValue): string {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') {
    if (!Array.isArray(value) && '__type' in value && value.__type === 'binary') {
      const binary = value as { previewHex?: string; length?: number; truncated?: boolean };
      // The browser only holds a hex preview of a binary cell, never the
      // full payload, so a truncated one says so instead of lying.
      const note = binary.truncated ? ` /* preview of ${binary.length ?? '?'} bytes */` : '';
      return `X'${String(binary.previewHex ?? '')}'${note}`;
    }
    return sqlString(JSON.stringify(value));
  }
  return sqlString(String(value));
}

/**
 * SQL INSERT statements for the copied rows.
 *
 * Pages of at most 100 rows become one multi-row INSERT; larger row sets
 * (the 250-row page size) fall back to one INSERT per row so a single
 * statement never grows unbounded.
 */
export function toSqlInsert(
  target: { database: string | null; table: string } | null,
  columns: QueryColumn[],
  rows: CellValue[][],
): string {
  if (rows.length === 0 || columns.length === 0) return '';
  const place = target
    ? `${target.database ? `${sqlIdentifier(target.database)}.` : ''}${sqlIdentifier(target.table)}`
    : null;
  const names = columns.map((column) => sqlIdentifier(column.name)).join(', ');
  const insertInto = (values: string): string =>
    `INSERT INTO ${place ?? sqlIdentifier('my_table')} (${names}) VALUES\n  ${values};`;
  const comment = place ? '' : '-- replace table name\n';
  const values = rows.map((row) => `(${row.map(sqlValue).join(', ')})`);
  if (values.length <= 100) return `${comment}${insertInto(values.join(',\n  '))}`;
  return `${comment}${values.map((value) => insertInto(value)).join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* Grid sorting and filtering                                          */
/* ------------------------------------------------------------------ */

const NUMERIC_LIKE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Whether a cell compares as a number: a finite number, or a string that is
 * one when read as text ("42", "-3.5", "1e6"). Masked cells ("••••••••") and
 * other prose are not numeric-like and compare as strings.
 */
export function isNumericLike(value: CellValue): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && NUMERIC_LIKE.test(trimmed);
  }
  return false;
}

function isBinaryCell(value: CellValue): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '__type' in value &&
    value.__type === 'binary'
  );
}

/**
 * Compares two cells of one column. Both numeric-like cells compare by
 * value ("10" sorts past "9"), everything else by text. NULL, undefined and
 * binary cells sort last whatever the direction, so the direction is only
 * applied to the informative comparison.
 */
export function compareCellValues(a: CellValue, b: CellValue, dir: 'asc' | 'desc' = 'asc'): number {
  const aLast = a == null || isBinaryCell(a);
  const bLast = b == null || isBinaryCell(b);
  if (aLast || bLast) {
    if (aLast && bLast) return 0;
    return aLast ? 1 : -1;
  }
  let cmp: number;
  if (isNumericLike(a) && isNumericLike(b)) {
    const left = Number(a);
    const right = Number(b);
    cmp = left === right ? 0 : left < right ? -1 : 1;
  } else {
    cmp = cellText(a).localeCompare(cellText(b));
  }
  return dir === 'desc' ? -cmp : cmp;
}

/**
 * Sorts a copy of the full row set by one column. `Array.prototype.sort` is
 * stable, so rows that compare equal keep their original order.
 */
export function sortRows(rows: CellValue[][], column: number, dir: 'asc' | 'desc'): CellValue[][] {
  const sorted = [...rows];
  sorted.sort((a, b) => compareCellValues(a[column], b[column], dir));
  return sorted;
}

/**
 * Keeps the rows where at least one cell contains the filter text,
 * case-insensitively. Cells match their displayed text, so a masked cell
 * matches its masked form, not the value behind it. An empty filter returns
 * the original array untouched.
 */
export function filterRows(rows: CellValue[][], filter: string): CellValue[][] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.some((value) => cellText(value).toLowerCase().includes(needle)));
}

export function downloadJson(filename: string, data: unknown): void {
  downloadText(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function scoreTone(score: number | null | undefined): 'mint' | 'warn' | 'danger' | 'muted' {
  if (score == null) return 'muted';
  if (score >= 80) return 'mint';
  if (score >= 60) return 'warn';
  return 'danger';
}

export function statusTone(status: string): string {
  switch (status) {
    case 'ran':
    case 'done':
      return 'mint';
    case 'running':
      return 'ember';
    case 'skipped':
      return 'warn';
    case 'denied':
    case 'unsupported':
    case 'error':
      return 'danger';
    default:
      return 'muted';
  }
}
