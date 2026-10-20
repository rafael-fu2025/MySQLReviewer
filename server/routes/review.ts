import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { StaticReviewResult, StoredReviewReport } from '../../shared/types';
import { getProfile } from '../store/profiles';
import { saveReport } from '../store/reports';
import { resolveProvider } from '../store/providers';
import { runStaticReview } from '../review/static-review';
import { runAiReview } from '../ai/analyze';
import { openSse } from '../sse';
import { asyncHandler, parseBody } from './util';

const StaticReviewSchema = z.object({
  profileId: z.string().max(200).optional(),
  database: z.string().max(200).nullable().optional(),
  sql: z.string().min(1).max(1_000_000),
  includeSchema: z.boolean().optional(),
  includeExplain: z.boolean().optional(),
  analyze: z.boolean().optional(),
});

const AiReviewBodySchema = z.object({
  profileId: z.string().max(200).nullable().optional(),
  database: z.string().max(200).nullable().optional(),
  sql: z.string().min(1).max(1_000_000),
  providerId: z.string().min(1).max(200),
  model: z.string().max(200).optional(),
  includeSchema: z.boolean().optional(),
  includeExplain: z.boolean().optional(),
  analyze: z.boolean().optional(),
  explain: z.unknown().optional(),
  findings: z.array(z.unknown()).max(1_000).optional(),
});

/**
 * Structural validation for a review the client already computed. Nested rule
 * output is passed through so this does not have to mirror every Finding field.
 */
const StaticReviewResultSchema = z
  .object({
    sql: z.string().max(1_000_000),
    statements: z.array(z.unknown()).max(10_000),
    findings: z.array(z.unknown()).max(10_000),
    score: z
      .object({
        score: z.number(),
        grade: z.enum(['A', 'B', 'C', 'D', 'F']),
      })
      .passthrough(),
    context: z.object({ database: z.string().nullable() }).passthrough(),
    explain: z.unknown().nullable().optional(),
    suggestions: z.array(z.unknown()).max(10_000),
    warnings: z.array(z.string().max(20_000)).max(1_000),
  })
  .passthrough();

export const SaveReviewSchema = z.object({
  profileId: z.string().max(200).optional(),
  database: z.string().max(200).nullable().optional(),
  sql: z.string().min(1).max(1_000_000),
  includeExplain: z.boolean().optional(),
  analyze: z.boolean().optional(),
  ai: z.unknown().nullable().optional(),
  review: StaticReviewResultSchema.optional(),
});

export type SaveReviewBody = z.infer<typeof SaveReviewSchema>;

/**
 * Resolve the artifact to persist. Saving must never execute the statement (or
 * anything else) against MySQL, so a client-supplied review is stored as-is.
 * Older clients that do not send one get a purely static review: no schema read
 * and no EXPLAIN/ANALYZE.
 */
export async function resolveReviewForSave(
  body: SaveReviewBody,
): Promise<StaticReviewResult> {
  if (body.review) return body.review as unknown as StaticReviewResult;
  return runStaticReview({
    profileId: body.profileId,
    database: body.database,
    sql: body.sql,
    includeSchema: false,
    includeExplain: false,
    analyze: false,
  });
}

export const reviewRouter = Router();

reviewRouter.post(
  '/static',
  asyncHandler(async (req, res) => {
    const body = parseBody(StaticReviewSchema, req);
    const result = await runStaticReview(body);
    res.json({ data: result });
  }),
);

reviewRouter.post(
  '/ai',
  asyncHandler(async (req, res) => {
    const body = parseBody(AiReviewBodySchema, req);
    const resolved = await resolveProvider(body.providerId);
    const provider = body.model?.trim()
      ? { ...resolved.public, model: body.model.trim() }
      : resolved.public;

    const sse = openSse(req, res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    sse.send('meta', {
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      streaming: provider.streaming,
    });

    try {
      const result = await runAiReview(
        {
          ...body,
          explain: body.explain as never,
          findings: body.findings as never,
        },
        provider,
        resolved.apiKey,
        (text) => sse.send('delta', { text }),
        controller.signal,
      );
      sse.send('result', { review: result.review });
      sse.send('done', {});
    } catch (error) {
      sse.send('error', {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code ?? 'AI_ERROR',
      });
    } finally {
      sse.close();
    }
  }),
);

reviewRouter.post(
  '/save',
  asyncHandler(async (req, res) => {
    const body = parseBody(SaveReviewSchema, req);
    const review = await resolveReviewForSave(body);
    const profile = body.profileId ? await getProfile(body.profileId).catch(() => null) : null;
    const report: StoredReviewReport = {
      id: `review_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      kind: 'review',
      title: `Review · ${body.database ?? 'no database'}`,
      createdAt: new Date().toISOString(),
      profile: profile
        ? {
            id: profile.id,
            name: profile.name,
            host: profile.host,
            port: profile.port,
            user: profile.user,
          }
        : null,
      databaseScope: body.database ? [body.database] : [],
      sql: body.sql,
      review,
      ai: (body.ai as StoredReviewReport['ai']) ?? null,
    };
    await saveReport(report);
    res.status(201).json({
      data: {
        id: report.id,
        title: report.title,
        createdAt: report.createdAt,
      },
    });
  }),
);
