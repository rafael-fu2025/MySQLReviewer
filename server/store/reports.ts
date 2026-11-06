import fs from 'node:fs/promises';
import path from 'node:path';
import { REPORTS_DIR, ensureDataDirs } from '../config';
import { AppError } from '../errors';
import type { AuditReport, ReportSummary, StoredReviewReport } from '../../shared/types';
import { writeJsonAtomic } from './json-store';

export type StoredReport = AuditReport | StoredReviewReport;

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/;

/** How many reports are retained; the oldest ones are dropped beyond it. */
export const MAX_REPORTS = 100;

/**
 * The summaries of the stored reports. They are kept in memory and persisted
 * in a small sidecar index, so a listing never has to read and parse every
 * stored report again.
 */
const INDEX_FILE = '.reports-index.json';

interface IndexEntry {
  mtimeMs: number;
  size: number;
  summary: ReportSummary;
}

interface ReportIndex {
  version: 1;
  reports: Record<string, IndexEntry>;
}

const entries = new Map<string, IndexEntry>();

function indexPath(): string {
  return path.join(REPORTS_DIR, INDEX_FILE);
}

function reportPath(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new AppError('INVALID_REPORT_ID', 'Invalid report id.', 400);
  }
  return path.join(REPORTS_DIR, `${id}.json`);
}

function toSummary(parsed: StoredReport): ReportSummary {
  const score = parsed.kind === 'audit' ? parsed.score : parsed.review.score;
  return {
    id: parsed.id,
    kind: parsed.kind,
    title: parsed.title,
    createdAt: parsed.createdAt,
    score: score?.score ?? 0,
    grade: score?.grade ?? '—',
    findingsTotal:
      parsed.kind === 'audit'
        ? parsed.findingsTotal
        : parsed.review.findings.length + (parsed.ai?.findings.length ?? 0),
    databaseScope: parsed.databaseScope ?? [],
    hasAi: Boolean(parsed.ai),
  };
}

/** Reads the persisted summary index; a missing or broken index is ignored. */
async function readIndexFile(): Promise<Map<string, IndexEntry>> {
  const found = new Map<string, IndexEntry>();
  try {
    const raw = await fs.readFile(indexPath(), 'utf8');
    const parsed = JSON.parse(raw) as ReportIndex;
    for (const [id, entry] of Object.entries(parsed?.reports ?? {})) {
      if (entry && typeof entry.mtimeMs === 'number' && entry.summary) found.set(id, entry);
    }
  } catch {
    // No index yet: the summaries are rebuilt from the report files.
  }
  return found;
}

async function persistIndex(): Promise<void> {
  const reports: Record<string, IndexEntry> = {};
  for (const [id, entry] of entries) reports[id] = entry;
  await writeJsonAtomic(indexPath(), { version: 1, reports } satisfies ReportIndex);
}

/** Report file names, ignoring the index and any other dot file. */
async function reportIds(): Promise<string[]> {
  let files: string[];
  try {
    files = await fs.readdir(REPORTS_DIR);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
    .map((file) => file.slice(0, -'.json'.length));
}

/** Drops the oldest reports once more than `MAX_REPORTS` are stored. */
async function enforceRetention(): Promise<void> {
  const ids = await reportIds();
  if (ids.length <= MAX_REPORTS) return;
  const modified = ids.map((id) => entries.get(id)?.mtimeMs ?? 0);
  const stamps = new Map<string, number>();
  ids.forEach((id, index) => stamps.set(id, modified[index]));
  // A report this process never saw has no timestamp yet; read it from disk.
  for (const id of ids) {
    if (stamps.get(id)) continue;
    const stat = await fs.stat(path.join(REPORTS_DIR, `${id}.json`)).catch(() => null);
    if (stat) stamps.set(id, stat.mtimeMs);
  }
  const ordered = ids
    .map((id) => ({ id, mtimeMs: stamps.get(id) ?? 0 }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const excess = ids.length - MAX_REPORTS;
  for (const entry of ordered.slice(0, excess)) {
    await fs.rm(path.join(REPORTS_DIR, `${entry.id}.json`), { force: true });
    entries.delete(entry.id);
  }
}

export async function saveReport(report: StoredReport): Promise<StoredReport> {
  ensureDataDirs();
  const file = reportPath(report.id);
  await writeJsonAtomic(file, report);
  const stat = await fs.stat(file);
  entries.set(report.id, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    summary: toSummary(report),
  });
  await enforceRetention();
  return report;
}

export async function getReport(id: string): Promise<StoredReport> {
  try {
    const raw = await fs.readFile(reportPath(id), 'utf8');
    return JSON.parse(raw) as StoredReport;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new AppError('REPORT_NOT_FOUND', 'Report not found.', 404);
    }
    throw error;
  }
}

export async function deleteReport(id: string): Promise<void> {
  try {
    await fs.unlink(reportPath(id));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      entries.delete(id);
      throw new AppError('REPORT_NOT_FOUND', 'Report not found.', 404);
    }
    throw error;
  }
  entries.delete(id);
  await persistIndex();
}

export async function listReports(): Promise<ReportSummary[]> {
  ensureDataDirs();
  const ids = await reportIds();
  if (ids.length === 0) return [];
  // Another process may have written reports; merge its index.
  const persisted = await readIndexFile();
  let changed = false;
  for (const [id, entry] of persisted) {
    const known = entries.get(id);
    if (!known) {
      entries.set(id, entry);
      changed = true;
    } else if (known.mtimeMs < entry.mtimeMs) {
      entries.set(id, entry);
      changed = true;
    }
  }

  const summaries: ReportSummary[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    seen.add(id);
    const full = path.join(REPORTS_DIR, `${id}.json`);
    try {
      const stat = await fs.stat(full);
      const cached = entries.get(id);
      // The summary is only reused while the report file is untouched; a
      // report changed or removed outside this process is never served from
      // a stale summary.
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        summaries.push(cached.summary);
        continue;
      }
      const raw = await fs.readFile(full, 'utf8');
      const parsed = JSON.parse(raw) as StoredReport;
      const summary = toSummary(parsed);
      entries.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      changed = true;
      summaries.push(summary);
    } catch {
      // A corrupt or vanished report should not break the list, and its stale
      // summary (if any) must not be reused.
      if (entries.delete(id)) changed = true;
    }
  }

  for (const id of [...entries.keys()]) {
    if (!seen.has(id)) {
      entries.delete(id);
      changed = true;
    }
  }
  if (changed) await persistIndex();
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
