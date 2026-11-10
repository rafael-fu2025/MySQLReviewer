import { Router } from 'express';
import { z } from 'zod';
import type { PracticeGenerateRequest, PracticeSet, PracticeTopic } from '../../shared/types';
import { AppError } from '../errors';
import { assertProfileAssigned, currentUser, sandboxScopeOverride } from '../auth';
import { logActivity } from '../store/activity';
import { resolveProvider } from '../store/providers';
import {
  clearPracticeAttempts,
  getPracticeDailyEntry,
  getPracticeProgress,
  getPracticeSet,
  listDuePracticeReviewItems,
  listPracticeAttempts,
  listPracticeAttemptsForSet,
  listPracticeSets,
  localDateKey,
  removePracticeReviewItem,
  setPracticeDailyEntry,
  stampPracticeAttemptOwner,
  stampPracticeSetOwner,
} from '../store/practice';
import {
  buildPracticeAnswers,
  canRevealPracticeAnswers,
  toPublicPracticeAttempt,
  toPublicPracticeProgress,
  toPublicPracticeReviewItem,
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
    'views',
    'procedures',
    'triggers',
    'design',
    'security',
  ]),
);

const GenerateSchema = z.object({
  profileId: z.string().min(1).max(200),
  database: z.string().min(1).max(200),
  tables: z.array(z.string().max(200)).max(50).optional(),
  topics: TopicsSchema.min(1).max(16),
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
    // Parse first: the security decision must be made on a validated profileId.
    const body = parseBody(GenerateSchema, req);
    const user = assertProfileAssigned(req, body.profileId);
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
        { scopeOverride: sandboxScopeOverride(req.user, body.profileId) },
      );
      await stampPracticeSetOwner(result.set.id, user.id);
      await logActivity({
        userId: user.id,
        username: user.username,
        action: 'practice-generate',
        profileId: body.profileId,
        database: body.database,
        detail: `${result.set.questions.length} challenges`,
      });
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
    // Parse first: the security decision must be made on a validated profileId.
    const body = parseBody(EvaluateSchema, req);
    const user = assertProfileAssigned(req, body.profileId);
    let provider = null;
    let apiKey: string | null = null;
    if (body.includeAi && body.providerId) {
      const resolved = await resolveProvider(body.providerId);
      provider = body.model?.trim()
        ? { ...resolved.public, model: body.model.trim() }
        : resolved.public;
      apiKey = resolved.apiKey;
    }
    // The evaluation can call the provider; tie its lifetime to the request so
    // a disconnected client cancels the (billable) call instead of leaving it
    // running.
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const evaluation = await evaluatePractice({
      profileId: body.profileId,
      setId: body.setId,
      questionId: body.questionId,
      userSql: body.userSql,
      userAnswer: body.userAnswer,
      provider,
      apiKey,
      includeAi: Boolean(body.includeAi),
      scopeOverride: sandboxScopeOverride(req.user, body.profileId),
      signal: controller.signal,
    });
    await stampPracticeAttemptOwner(body.profileId, body.setId, body.questionId, user.id);
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'practice-evaluate',
      profileId: body.profileId,
      detail: `score ${evaluation.scores.overall}`,
    });
    res.json({ data: evaluation });
  }),
);

practiceRouter.get(
  '/sets',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(ProfileQuery, req);
    const sets = await listPracticeSets(
      query.profileId,
      query.limit ?? 20,
      user.role === 'member' ? user.id : undefined,
    );
    res.json({ data: sets.map(toPublicPracticeSet) });
  }),
);

practiceRouter.get(
  '/sets/:id/answers',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
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
    if (user.role === 'member' && set.userId !== user.id) {
      throw new AppError(
        'PRACTICE_SET_FORBIDDEN',
        'This practice set was generated by another account.',
        403,
      );
    }
    const attempts = await listPracticeAttemptsForSet(
      query.profileId,
      set.id,
      user.role === 'member' ? user.id : undefined,
    );
    const attempted = new Set(attempts.map((attempt) => attempt.questionId));
    res.json({ data: buildPracticeAnswers(set, attempted) });
  }),
);

practiceRouter.get(
  '/attempts',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(ProfileQuery, req);
    const attempts = await listPracticeAttempts(
      query.profileId,
      query.limit ?? 30,
      user.role === 'member' ? user.id : undefined,
    );
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
    const user = currentUser(req);
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
    if (user.role === 'member' && set.userId !== user.id) {
      throw new AppError(
        'PRACTICE_SET_FORBIDDEN',
        'This practice set was generated by another account.',
        403,
      );
    }
    const attempts = await listPracticeAttemptsForSet(
      query.profileId,
      set.id,
      user.role === 'member' ? user.id : undefined,
    );
    res.json({ data: attempts.map(toPublicPracticeAttempt) });
  }),
);

practiceRouter.get(
  '/progress',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(ProfileQuery, req);
    res.json({
      data: toPublicPracticeProgress(
        await getPracticeProgress(query.profileId, user.role === 'member' ? user.id : undefined),
      ),
    });
  }),
);

practiceRouter.delete(
  '/attempts',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(ProfileQuery, req);
    await clearPracticeAttempts(query.profileId, user.role === 'member' ? user.id : undefined);
    res.json({ data: { cleared: true } });
  }),
);

/* ------------------------------------------------------------------ */
/* Learning loop: review queue, daily challenge                        */
/* ------------------------------------------------------------------ */

practiceRouter.get(
  '/review',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(ProfileQuery, req);
    const items = await listDuePracticeReviewItems(
      query.profileId,
      user.role === 'member' ? user.id : undefined,
    );
    res.json({ data: items.map(toPublicPracticeReviewItem) });
  }),
);

practiceRouter.delete(
  '/review/:setId/:questionId',
  asyncHandler(async (req, res) => {
    // Parse first: the security decision must be made on a validated profileId.
    const query = parseQuery(ProfileQuery, req);
    assertProfileAssigned(req, query.profileId);
    const setId = param(req, 'setId');
    const questionId = param(req, 'questionId');
    const dismissed = await removePracticeReviewItem(query.profileId, setId, questionId);
    res.json({ data: { dismissed } });
  }),
);

/** The most recently practiced database of the profile, for grounding a generation. */
async function dailyDatabaseForProfile(profileId: string, userId?: string): Promise<string | null> {
  const sets = await listPracticeSets(profileId, 1, userId);
  if (sets[0]) return sets[0].database;
  const attempts = await listPracticeAttempts(profileId, 1, userId);
  return attempts[0]?.database ?? null;
}

/** The profile's most recent set that still holds an unattempted executable question. */
async function pickFallbackDailySet(
  profileId: string,
  userId?: string,
): Promise<PracticeSet | null> {
  const sets = await listPracticeSets(profileId, 20, userId);
  for (const set of sets) {
    const attempts = await listPracticeAttemptsForSet(profileId, set.id, userId);
    const attempted = new Set(attempts.map((attempt) => attempt.questionId));
    if (set.questions.some((question) => question.execute && !attempted.has(question.id))) {
      return set;
    }
  }
  return null;
}

practiceRouter.get(
  '/daily',
  asyncHandler(async (req, res) => {
    // Parse first: the security decision must be made on a validated profileId.
    const query = parseQuery(ProfileQuery, req);
    const user = assertProfileAssigned(req, query.profileId);
    const memberFilter = user.role === 'member' ? user.id : undefined;
    const date = localDateKey(new Date());

    // Today's entry wins while its set still exists (and is still the member's).
    const existing = await getPracticeDailyEntry(query.profileId);
    if (existing && existing.date === date) {
      try {
        const set = await getPracticeSet(existing.setId);
        if (!(memberFilter && set.userId !== memberFilter)) {
          res.json({ data: { date, set: toPublicPracticeSet(set) } });
          return;
        }
      } catch {
        // The set fell out of the store cap; produce a fresh challenge below.
      }
    }

    // The generation can call the provider; tie its lifetime to the request so
    // a disconnected client cancels the (billable) call.
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let set: PracticeSet | null = null;
    let reason: string | undefined;
    try {
      const resolved = await resolveProvider(null);
      const provider = resolved.public;
      const database = await dailyDatabaseForProfile(query.profileId, memberFilter);
      if (!database) {
        throw new AppError(
          'PRACTICE_DAILY_NO_DATABASE',
          'No practiced database to build a daily challenge from.',
          400,
        );
      }
      const progress = await getPracticeProgress(query.profileId, memberFilter);
      const fallbackTopics: PracticeTopic[] = ['select'];
      const topics =
        progress.recommendedTopics.length > 0 ? progress.recommendedTopics : fallbackTopics;
      const request: PracticeGenerateRequest = {
        profileId: query.profileId,
        database,
        topics,
        difficulty: 'medium',
        count: 1,
        providerId: provider.id,
      };
      const result = await generatePracticeSet(
        request,
        provider,
        resolved.apiKey,
        () => {},
        controller.signal,
        { scopeOverride: sandboxScopeOverride(req.user, query.profileId) },
      );
      set = result.set;
      await stampPracticeSetOwner(set.id, user.id);
      await logActivity({
        userId: user.id,
        username: user.username,
        action: 'practice-daily',
        profileId: query.profileId,
        database,
        detail: '1 challenge',
      });
    } catch (error) {
      reason =
        (error as { code?: string }).code === 'NO_AI_PROVIDER'
          ? 'no-provider'
          : 'generation-failed';
    }

    if (!set) {
      // No provider or a failed generation: fall back to a fresh executable
      // question the profile has not attempted yet.
      const fallback = await pickFallbackDailySet(query.profileId, memberFilter);
      if (!fallback) {
        res.json({ data: { date, set: null, reason: reason ?? 'no-candidate' } });
        return;
      }
      set = fallback;
    }

    // The pointer persists for fallback picks too, so the day stays stable.
    await setPracticeDailyEntry(query.profileId, { date, setId: set.id });
    res.json({ data: { date, set: toPublicPracticeSet(set) } });
  }),
);
