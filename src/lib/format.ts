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
