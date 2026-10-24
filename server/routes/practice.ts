import { Router } from 'express';
import { z } from 'zod';
import type { PracticeGenerateRequest } from '../../shared/types';
import { AppError } from '../errors';
import { resolveProvider } from '../store/providers';
import {
  clearPracticeAttempts,
  getPracticeProgress,
  getPracticeSet,
  listPracticeAttempts,
  listPracticeAttemptsForSet,
  listPracticeSets,
} from '../store/practice';
import {
  buildPracticeAnswers,
  canRevealPracticeAnswers,
  toPublicPracticeAttempt,
  toPublicPracticeProgress,
  toPublicPracticeSet,
} from '../db/practice';
import { evaluatePractice, generatePracticeSet } from '../ai/practice';
import { openSse } from '../sse';
import { asyncHandler, param, parseBody, parseQuery } from './util';

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
  count: z.coerce.number().int().min(1).max(25),
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

const AnswersQuery = z.object({
  profileId: z.string().min(1).max(200),
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
      // Never stream the reference solution: the client gets the client-safe shape.
      sse.send('result', { set: toPublicPracticeSet(result.set) });
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
    const sets = await listPracticeSets(query.profileId, query.limit ?? 20);
    res.json({ data: sets.map(toPublicPracticeSet) });
  }),
);

practiceRouter.get(
  '/sets/:id/answers',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const query = parseQuery(AnswersQuery, req);
    const set = await getPracticeSet(id);
    if (!canRevealPracticeAnswers(set, query.profileId)) {
      throw new AppError(
        'PRACTICE_SET_FORBIDDEN',
        'This practice set belongs to another connection.',
        403,
      );
    }
    const attempts = await listPracticeAttemptsForSet(query.profileId, set.id);
    const attempted = new Set(attempts.map((attempt) => attempt.questionId));
    res.json({ data: buildPracticeAnswers(set, attempted) });
  }),
);

practiceRouter.get(
  '/attempts',
  asyncHandler(async (req, res) => {
    const query = parseQuery(ProfileQuery, req);
    const attempts = await listPracticeAttempts(query.profileId, query.limit ?? 30);
    res.json({ data: attempts.map(toPublicPracticeAttempt) });
  }),
);

/**
 * The graded answers of one set. The client uses this to rebuild the answered
 * state after a reload, so the attempt history has to be readable per set and
 * not only through the profile-wide listing.
 */
practiceRouter.get(
  '/sets/:id/attempts',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const query = parseQuery(AnswersQuery, req);
    const set = await getPracticeSet(id);
    if (!canRevealPracticeAnswers(set, query.profileId)) {
      throw new AppError(
        'PRACTICE_SET_FORBIDDEN',
        'This practice set belongs to another connection.',
        403,
      );
    }
    const attempts = await listPracticeAttemptsForSet(query.profileId, set.id);
    res.json({ data: attempts.map(toPublicPracticeAttempt) });
  }),
);

practiceRouter.get(
  '/progress',
  asyncHandler(async (req, res) => {
    const query = parseQuery(ProfileQuery, req);
    res.json({ data: toPublicPracticeProgress(await getPracticeProgress(query.profileId)) });
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
