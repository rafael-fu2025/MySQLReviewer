import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, REPORTS_DIR } from '../config';
import { AppError } from '../errors';
import type { AuditReport, ReportSummary, StoredReviewReport } from '../../shared/types';
import { JsonStore } from './json-store';

export type StoredReport = AuditReport | StoredReviewReport;

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/;

/** How many reports are retained; the oldest ones are dropped beyond it. */
export const MAX_REPORTS = 100;

/**
 * Reports live in one per-installation document (`data/reports.json`, or a
 * row of the `mylens` schema in MySQL mode) through the shared storage
 * backend — the pre-storage-layer layout (one file per report under
 * `data/reports/` plus a summary sidecar) is imported once, lazily, and its
 * files are renamed out of the way so a deleted report can never resurface
 * from them.
 */
interface ReportsDocument {
  version: 1;
  reports: Record<string, StoredReport>;
}

function blankDocument(): ReportsDocument {
  return { version: 1, reports: {} };
}

const store = new JsonStore<ReportsDocument>(path.join(DATA_DIR, 'reports.json'), blankDocument);

function assertValidId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new AppError('INVALID_REPORT_ID', 'Invalid report id.', 400);
  }
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

/**
 * One-time import of the pre-storage-layer layout. Idempotent per report
 * (ids already in the document are skipped) and non-destructive: imported
 * files are renamed with an `.imported` suffix instead of deleted, so their
 * content stays inspectable while a deleted report can never be resurrected
 * from them by a later process.
 */
let legacyChecked = false;
async function importLegacyDirectory(document: ReportsDocument): Promise<void> {
  if (legacyChecked) return;
  legacyChecked = true;
  let files: string[];
  try {
    files = await fs.readdir(REPORTS_DIR);
  } catch {
    return; // No legacy directory: nothing to import.
  }
  const legacy = files.filter((file) => file.endsWith('.json') && !file.startsWith('.'));
  let imported = false;
  for (const file of legacy) {
    const id = file.slice(0, -'.json'.length);
    if (!ID_PATTERN.test(id)) continue;
    try {
      const raw = await fs.readFile(path.join(REPORTS_DIR, file), 'utf8');
      const parsed = JSON.parse(raw) as StoredReport;
      if (!parsed || typeof parsed.id !== 'string' || document.reports[parsed.id]) continue;
      document.reports[parsed.id] = parsed;
      await fs.rename(path.join(REPORTS_DIR, file), path.join(REPORTS_DIR, `${file}.imported`));
      imported = true;
    } catch {
      // A corrupt or unimportable legacy report is skipped, not fatal.
    }
  }
  if (imported) {
    // The imported set obeys the same retention cap as saved reports.
    const ordered = Object.values(document.reports).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const evicted of ordered.slice(0, Math.max(0, ordered.length - MAX_REPORTS))) {
      delete document.reports[evicted.id];
    }
    await store.write(document);
  }
}

export async function listReports(): Promise<ReportSummary[]> {
  const document = await store.read();
  await importLegacyDirectory(document);
  const summaries = Object.values(document.reports).map((report) => toSummary(report));
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getReport(id: string): Promise<StoredReport> {
  assertValidId(id);
  const document = await store.read();
  await importLegacyDirectory(document);
  const report = document.reports[id];
  if (!report) {
    throw new AppError('REPORT_NOT_FOUND', 'Report not found.', 404);
  }
  return report;
}

export async function saveReport(report: StoredReport): Promise<StoredReport> {
  assertValidId(report.id);
  const document = await store.read();
  await importLegacyDirectory(document);
  document.reports[report.id] = report;
  // Retention: keep the newest MAX_REPORTS reports by creation time.
  const ordered = Object.values(document.reports).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  for (const evicted of ordered.slice(0, Math.max(0, ordered.length - MAX_REPORTS))) {
    delete document.reports[evicted.id];
  }
  await store.write(document);
  return report;
}

export async function deleteReport(id: string): Promise<void> {
  assertValidId(id);
  const document = await store.read();
  await importLegacyDirectory(document);
  if (!document.reports[id]) {
    throw new AppError('REPORT_NOT_FOUND', 'Report not found.', 404);
  }
  delete document.reports[id];
  await store.write(document);
}
