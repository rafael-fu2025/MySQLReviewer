import fs from 'node:fs/promises';
import path from 'node:path';
import { REPORTS_DIR, ensureDataDirs } from '../config';
import { AppError } from '../errors';
import type { AuditReport, ReportSummary, StoredReviewReport } from '../../shared/types';
import { writeJsonAtomic } from './json-store';

export type StoredReport = AuditReport | StoredReviewReport;

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/;

function reportPath(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new AppError('INVALID_REPORT_ID', 'Invalid report id.', 400);
  }
  return path.join(REPORTS_DIR, `${id}.json`);
}

export async function saveReport(report: StoredReport): Promise<StoredReport> {
  ensureDataDirs();
  await writeJsonAtomic(reportPath(report.id), report);
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
      throw new AppError('REPORT_NOT_FOUND', 'Report not found.', 404);
    }
    throw error;
  }
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
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(REPORTS_DIR, file), 'utf8');
      const parsed = JSON.parse(raw) as StoredReport;
      const score = parsed.kind === 'audit' ? parsed.score : parsed.review.score;
      summaries.push({
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
      });
    } catch {
      // A corrupt report should not break the list.
    }
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
