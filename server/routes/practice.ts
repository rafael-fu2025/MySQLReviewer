import { Router } from 'express';
import { z } from 'zod';
import type { PracticeGenerateRequest } from '../../shared/types';
import { resolveProvider } from '../store/providers';
import {
  clearPracticeAttempts,
  getPracticeProgress,
  listPracticeAttempts,
  listPracticeSets,
} from '../store/practice';
import {
  evaluatePractice,
  generatePracticeSet,
} from '../ai/practice';
import { openSse } from '../sse';
import { asyncHandler, parseBody, parseQuery } from './util';

const TopicsSchema = z.array(
  z.enum([
    'select',
    'joins',
    'aggregation',
    'subqueries',
    'cte',
    'window',
    'set-ops',
    'dml',
    'ddl',
    'indexes',
    'transactions',
    'design',
    'security',
  ]),
);

const GenerateSchema = z.object({
  profileId: z.string().min(1).max(200),
  database: z.string().min(1).max(200),
  tables: z.array(z.string().max(200)).max(50).optional(),
  topics: TopicsSchema.min(1).max(13),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']),
  count: z.coerce.number().int().min(1).max(10),
  providerId: z.string().min(1).max(200),
  model: z.string().max(200).optional(),
  includeSampleData: z.boolean().optional(),
});

const EvaluateSchema = z.object({
  profileId: z.string().min(1).max(200),
  setId: z.string().min(1).max(200),
  questionId: z.string().min(1).max(200),
  userSql: z.string().max(200_000).optional(),
  userAnswer: z.string().max(20_000).optional(),
  providerId: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  includeAi: z.boolean().optional(),
});

const ProfileQuery = z.object({
  profileId: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const practiceRouter = Router();

practiceRouter.post(
  '/generate',
  asyncHandler(async (req, res) => {
    const body = parseBody(GenerateSchema, req);
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
      const request: PracticeGenerateRequest = {
        ...body,
        providerId: provider.id,
      };
      const result = await generatePracticeSet(
        request,
        provider,
        resolved.apiKey,
        (text) => sse.send('delta', { text }),
        controller.signal,
      );
      sse.send('result', { set: result.set });
      sse.send('done', {});
    } catch (error) {
      sse.send('error', {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code ?? 'PRACTICE_ERROR',
      });
    } finally {
      sse.close();
    }
  }),
);

practiceRouter.post(
  '/evaluate',
  asyncHandler(async (req, res) => {
    const body = parseBody(EvaluateSchema, req);
    let provider = null;
    let apiKey: string | null = null;
    if (body.includeAi && body.providerId) {
      const resolved = await resolveProvider(body.providerId);
      provider = body.model?.trim()
        ? { ...resolved.public, model: body.model.trim() }
        : resolved.public;
      apiKey = resolved.apiKey;
    }
    const evaluation = await evaluatePractice({
      profileId: body.profileId,
      setId: body.setId,
      questionId: body.questionId,
      userSql: body.userSql,
      userAnswer: body.userAnswer,
      provider,
      apiKey,
      includeAi: Boolean(body.includeAi),
    });
    res.json({ data: evaluation });
  }),
);

practiceRouter.get(
  '/sets',
  asyncHandler(async (req, res) => {
    const query = parseQuery(ProfileQuery, req);
    res.json({ data: await listPracticeSets(query.profileId, query.limit ?? 20) });
  }),
);

practiceRouter.get(
  '/attempts',
  asyncHandler(async (req, res) => {
    const query = parseQuery(ProfileQuery, req);
    res.json({
      data: await listPracticeAttempts(query.profileId, query.limit ?? 30),
    });
  }),
);

practiceRouter.get(
  '/progress',
  asyncHandler(async (req, res) => {
    const query = parseQuery(ProfileQuery, req);
    res.json({ data: await getPracticeProgress(query.profileId) });
  }),
);

practiceRouter.delete(
  '/attempts',
  asyncHandler(async (req, res) => {
    const query = parseQuery(ProfileQuery, req);
    await clearPracticeAttempts(query.profileId);
    res.json({ data: { cleared: true } });
  }),
);
