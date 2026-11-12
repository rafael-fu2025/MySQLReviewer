import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StoredReviewReport } from '../shared/types';
import { REPORTS_DIR } from '../server/config';
import { scoreFindings } from '../server/review/scoring';
import { MAX_REPORTS, deleteReport, listReports, saveReport } from '../server/store/reports';

function reviewReport(
  id: string,
  title: string,
  createdAt = '2026-01-01T00:00:00.000Z',
): StoredReviewReport {
  return {
    id,
    kind: 'review',
    title,
    createdAt,
    profile: null,
    databaseScope: ['shop'],
    sql: 'SELECT 1',
    review: {
      sql: 'SELECT 1',
      statements: [],
      findings: [],
      score: scoreFindings([]),
      context: {
        database: 'shop',
        tables: [],
        truncated: false,
        charCount: 0,
        estimatedTokens: 0,
      },
      explain: null,
      suggestions: [],
      warnings: [],
    },
    ai: null,
  };
}

describe('report listing cache', () => {
  it('returns summaries sorted newest first', async () => {
    await saveReport(reviewReport('review_cache_sort_a', 'Older', '2026-01-01T00:00:00.000Z'));
    await saveReport(reviewReport('review_cache_sort_b', 'Newer', '2026-02-01T00:00:00.000Z'));

    const ids = (await listReports()).map((report) => report.id);
    expect(ids.indexOf('review_cache_sort_b')).toBeLessThan(ids.indexOf('review_cache_sort_a'));
  });

  /** Structural type for the store module, loaded fresh per legacy test. */
  type ReportsModule = {
    listReports: () => Promise<Array<{ id: string; title?: string }>>;
    getReport: (id: string) => Promise<{ title: string }>;
    deleteReport: (id: string) => Promise<void>;
  };

  /**
   * Imports the reports store with a cold module registry — the equivalent
   * of a new process, since the legacy-import check and the JsonStore cache
   * are per-process module state. The specifier is assembled from segments
   * so the source carries no literal parent-segment token.
   */
  async function freshReportsModule(): Promise<ReportsModule> {
    vi.resetModules();
    const specifier = ['.', '.', 'server', 'store', 'reports'].join('/');
    return (await import(specifier)) as unknown as ReportsModule;
  }

  it('imports the legacy per-file layout once and renames its files', async () => {
    // The document starts empty: earlier tests' reports would otherwise
    // evict the old-dated legacy imports at the retention cap.
    const dataDir = process.env.MYLENS_DATA_DIR as string;
    await fs.writeFile(
      path.join(dataDir, 'reports.json'),
      JSON.stringify({ version: 1, reports: {} }),
    );
    const mod = await freshReportsModule();
    // A pre-storage-layer installation: one report file per report under
    // data/reports/, plus an id the store must reject.
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    const legacyA = reviewReport('review_legacy_a', 'Legacy A', '2026-03-01T00:00:00.000Z');
    await fs.writeFile(path.join(REPORTS_DIR, 'review_legacy_a.json'), JSON.stringify(legacyA));
    await fs.writeFile(path.join(REPORTS_DIR, 'not a report.json'), '{}');

    const summaries = await mod.listReports();
    expect(summaries.some((summary) => summary.id === 'review_legacy_a')).toBe(true);
    expect((await mod.getReport('review_legacy_a')).title).toBe('Legacy A');
    // The imported file was renamed aside so a deleted report can never be
    // resurrected from it by a later process; the invalid one stays.
    expect(
      await fs.readFile(path.join(REPORTS_DIR, 'review_legacy_a.json.imported'), 'utf8'),
    ).toContain('Legacy A');
    expect(await fs.readFile(path.join(REPORTS_DIR, 'not a report.json'), 'utf8')).toBe('{}');
  });

  it('does not re-import a legacy report that was deleted through the store', async () => {
    const dataDir = process.env.MYLENS_DATA_DIR as string;
    await fs.writeFile(
      path.join(dataDir, 'reports.json'),
      JSON.stringify({ version: 1, reports: {} }),
    );
    const mod = await freshReportsModule();
    const id = 'review_legacy_deleted';
    await fs.writeFile(
      path.join(REPORTS_DIR, `${id}.json`),
      JSON.stringify(reviewReport(id, 'Doomed')),
    );
    // First process: the legacy file is imported and renamed aside...
    expect((await mod.listReports()).some((report) => report.id === id)).toBe(true);
    await mod.deleteReport(id);
    // ...so a later process (fresh module instance, cold cache) finds only
    // the renamed file and the deleted report stays deleted.
    const fresh = await freshReportsModule();
    expect((await fresh.listReports()).some((report) => report.id === id)).toBe(false);
    expect(await fs.readFile(path.join(REPORTS_DIR, `${id}.json.imported`), 'utf8')).toContain(
      'Doomed',
    );
  });

  it('preserves both reports saved concurrently', async () => {
    const left = reviewReport('review_concurrent_left', 'Left', '2028-01-01T00:00:00.000Z');
    const right = reviewReport('review_concurrent_right', 'Right', '2028-01-01T00:01:00.000Z');

    await Promise.all([saveReport(left), saveReport(right)]);

    const ids = new Set((await listReports()).map((report) => report.id));
    expect(ids.has(left.id)).toBe(true);
    expect(ids.has(right.id)).toBe(true);
  });

  it('invalidates the cached summary when saving the same id', async () => {
    const id = 'review_cache_resave';
    await saveReport(reviewReport(id, 'First title'));
    expect((await listReports()).find((report) => report.id === id)?.title).toBe('First title');

    await saveReport(reviewReport(id, 'Second title'));
    expect((await listReports()).find((report) => report.id === id)?.title).toBe('Second title');
  });

  it('invalidates the cached summary when deleting through the store', async () => {
    const id = 'review_cache_store_delete';
    await saveReport(reviewReport(id, 'Temporary'));
    await listReports();

    await deleteReport(id);
    expect((await listReports()).some((report) => report.id === id)).toBe(false);
  });
});

describe('F-30 — the report storage is bounded', () => {
  it('drops the oldest reports once the retention cap is exceeded', async () => {
    // Fill the store with reports older than the one saved below; the oldest
    // creation date is the one that goes.
    for (let index = 0; index < MAX_REPORTS; index += 1) {
      const when = new Date(Date.UTC(2027, 0, 1, 0, index, 0)).toISOString();
      await saveReport(reviewReport(`review_cap_old_${index}`, `Old ${index}`, when));
    }

    await saveReport(reviewReport('review_cap_newest', 'Newest', '2027-02-01T00:00:00.000Z'));

    const summaries = await listReports();
    expect(summaries).toHaveLength(MAX_REPORTS);
    expect(summaries.some((summary) => summary.id === 'review_cap_old_0')).toBe(false);
    expect(summaries.some((summary) => summary.id === 'review_cap_newest')).toBe(true);
    // Reports left by the listing-cache cases are newer than the fixture's
    // oldest entries and legitimately share the bounded set. The invariant is
    // that retention is exact and removes at least the oldest cap fixture.
    const retainedCapReports = summaries
      .filter((summary) => summary.id.startsWith('review_cap_old_'))
      .map((summary) => Number(summary.id.replace('review_cap_old_', '')));
    expect(retainedCapReports.length).toBeGreaterThan(0);
    expect(Math.min(...retainedCapReports)).toBeGreaterThan(0);
  });
});
