import fs from 'node:fs/promises';
import path from 'node:path';
import { REPORTS_DIR, ensureDataDirs } from '../config';
import { AppError } from '../errors';
import type { AuditReport, ReportSummary, StoredReviewReport } from '../../shared/types';
import { writeJsonAtomic } from './json-store';

export type StoredReport = AuditReport | StoredReviewReport;

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/;

interface CachedSummary {
  mtimeMs: number;
  size: number;
  summary: ReportSummary;
}

/**
 * Summaries keyed by report id. Each entry is validated against the file's
 * mtime and size before it is reused, so a report changed or removed outside
 * this process is never served from a stale cache.
 */
const summaryCache = new Map<string, CachedSummary>();

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

export async function saveReport(report: StoredReport): Promise<StoredReport> {
  ensureDataDirs();
  await writeJsonAtomic(reportPath(report.id), report);
  summaryCache.delete(report.id);
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
      summaryCache.delete(id);
      throw new AppError('REPORT_NOT_FOUND', 'Report not found.', 404);
    }
    throw error;
  }
  summaryCache.delete(id);
}

export async function listReports(): Promise<ReportSummary[]> {
  ensureDataDirs();
  let files: string[] = [];
  try {
    files = await fs.readdir(REPORTS_DIR);
  } catch {
    return [];
  }
  const summaries: ReportSummary[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    seen.add(id);
    const full = path.join(REPORTS_DIR, file);
    try {
      const stat = await fs.stat(full);
      const cached = summaryCache.get(id);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        summaries.push(cached.summary);
        continue;
      }
      const raw = await fs.readFile(full, 'utf8');
      const parsed = JSON.parse(raw) as StoredReport;
      const summary = toSummary(parsed);
      summaryCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      summaries.push(summary);
    } catch {
      // A corrupt or vanished report should not break the list, and its stale
      // summary (if any) must not be reused.
      summaryCache.delete(id);
    }
  }
  for (const id of summaryCache.keys()) {
    if (!seen.has(id)) summaryCache.delete(id);
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
