import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredReviewReport } from '../shared/types';
import { REPORTS_DIR } from '../server/config';
import { scoreFindings } from '../server/review/scoring';
import { deleteReport, listReports, saveReport } from '../server/store/reports';

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
    expect(ids.indexOf('review_cache_sort_b')).toBeLessThan(
      ids.indexOf('review_cache_sort_a'),
    );
  });

  it('reflects a report rewritten outside the process', async () => {
    const id = 'review_cache_external_edit';
    await saveReport(reviewReport(id, 'Original title'));
    expect((await listReports()).find((report) => report.id === id)?.title).toBe(
      'Original title',
    );

    // A different-size body guarantees a different mtime+size fingerprint.
    const rewritten = reviewReport(id, 'Rewritten externally with a longer title');
    await fs.writeFile(
      path.join(REPORTS_DIR, `${id}.json`),
      `${JSON.stringify(rewritten, null, 2)}\n`,
      'utf8',
    );

    expect((await listReports()).find((report) => report.id === id)?.title).toBe(
      'Rewritten externally with a longer title',
    );
  });

  it('drops a report deleted outside the process', async () => {
    const id = 'review_cache_external_delete';
    await saveReport(reviewReport(id, 'Doomed'));
    expect((await listReports()).some((report) => report.id === id)).toBe(true);

    await fs.unlink(path.join(REPORTS_DIR, `${id}.json`));
    expect((await listReports()).some((report) => report.id === id)).toBe(false);
  });

  it('invalidates the cached summary when saving the same id', async () => {
    const id = 'review_cache_resave';
    await saveReport(reviewReport(id, 'First title'));
    expect((await listReports()).find((report) => report.id === id)?.title).toBe(
      'First title',
    );

    await saveReport(reviewReport(id, 'Second title'));
    expect((await listReports()).find((report) => report.id === id)?.title).toBe(
      'Second title',
    );
  });

  it('invalidates the cached summary when deleting through the store', async () => {
    const id = 'review_cache_store_delete';
    await saveReport(reviewReport(id, 'Temporary'));
    await listReports();

    await deleteReport(id);
    expect((await listReports()).some((report) => report.id === id)).toBe(false);
  });
});
