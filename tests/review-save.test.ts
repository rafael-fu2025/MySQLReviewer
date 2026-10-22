import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaticReviewResult } from '../shared/types';
import { scoreFindings } from '../server/review/scoring';

const mocks = vi.hoisted(() => ({ runStaticReview: vi.fn() }));

vi.mock('../server/review/static-review', () => ({
  runStaticReview: mocks.runStaticReview,
}));

const { SaveReviewSchema, resolveReviewForSave } = await import('../server/routes/review');

function review(sql = 'SELECT 1'): StaticReviewResult {
  return {
    sql,
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
  };
}

describe('review save', () => {
  beforeEach(() => {
    mocks.runStaticReview.mockReset();
  });

  it('stores the client-supplied review without recomputing', async () => {
    const supplied = review();
    const body = SaveReviewSchema.parse({
      profileId: 'profile-1',
      database: 'shop',
      sql: 'SELECT 1',
      review: supplied,
    });

    const stored = await resolveReviewForSave(body);

    expect(stored).toEqual(supplied);
    expect(mocks.runStaticReview).not.toHaveBeenCalled();
  });

  it('recomputes statically, without schema reads or EXPLAIN, when no review is sent', async () => {
    const supplied = review();
    mocks.runStaticReview.mockResolvedValue(supplied);
    const body = SaveReviewSchema.parse({
      profileId: 'profile-1',
      database: 'shop',
      sql: 'SELECT 1',
      includeExplain: true,
      analyze: true,
    });

    const stored = await resolveReviewForSave(body);

    expect(stored).toEqual(supplied);
    expect(mocks.runStaticReview).toHaveBeenCalledTimes(1);
    expect(mocks.runStaticReview).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        database: 'shop',
        sql: 'SELECT 1',
        includeSchema: false,
        includeExplain: false,
        analyze: false,
      }),
    );
  });

  it('rejects a malformed review payload', () => {
    const result = SaveReviewSchema.safeParse({
      sql: 'SELECT 1',
      review: { ...review(), score: { score: 90, grade: 'Z' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a review payload missing required fields', () => {
    const result = SaveReviewSchema.safeParse({
      sql: 'SELECT 1',
      review: { sql: 'SELECT 1' },
    });
    expect(result.success).toBe(false);
  });
});
