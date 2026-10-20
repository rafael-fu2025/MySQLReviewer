import path from 'node:path';
import type {
  PracticeAttempt,
  PracticeProgress,
  PracticeProgressTopic,
  PracticeSet,
  PracticeTopic,
} from '../../shared/types';
import { PRACTICE_TOPICS } from '../../shared/types';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import { JsonStore } from './json-store';

interface PracticeFile {
  sets: PracticeSet[];
  attempts: PracticeAttempt[];
}

const store = new JsonStore<PracticeFile>(path.join(DATA_DIR, 'practice.json'), () => ({
  sets: [],
  attempts: [],
}));

const MAX_SETS = 40;
const MAX_ATTEMPTS = 1_500;

export async function savePracticeSet(set: PracticeSet): Promise<PracticeSet> {
  await store.update((current) => ({
    sets: [set, ...current.sets.filter((item) => item.id !== set.id)].slice(0, MAX_SETS),
    attempts: current.attempts,
  }));
  return set;
}

export async function getPracticeSet(id: string): Promise<PracticeSet> {
  const file = await store.read();
  const set = file.sets.find((item) => item.id === id);
  if (!set) {
    throw new AppError('PRACTICE_SET_NOT_FOUND', 'Practice set not found.', 404);
  }
  return set;
}

export async function listPracticeSets(
  profileId?: string,
  limit = 20,
): Promise<PracticeSet[]> {
  const file = await store.read();
  const sets = profileId
    ? file.sets.filter((set) => set.profileId === profileId)
    : file.sets;
  return sets.slice(0, Math.max(1, Math.min(50, limit)));
}

export async function addPracticeAttempt(
  attempt: PracticeAttempt,
): Promise<PracticeAttempt> {
  await store.update((current) => ({
    sets: current.sets,
    attempts: [attempt, ...current.attempts].slice(0, MAX_ATTEMPTS),
  }));
  return attempt;
}

export async function listPracticeAttempts(
  profileId?: string,
  limit = 30,
): Promise<PracticeAttempt[]> {
  const file = await store.read();
  const attempts = profileId
    ? file.attempts.filter((attempt) => attempt.profileId === profileId)
    : file.attempts;
  return attempts.slice(0, Math.max(1, Math.min(100, limit)));
}

export async function clearPracticeAttempts(profileId?: string): Promise<void> {
  await store.update((current) => ({
    sets: current.sets,
    attempts: profileId
      ? current.attempts.filter((attempt) => attempt.profileId !== profileId)
      : [],
  }));
}

export async function getPracticeProgress(profileId: string): Promise<PracticeProgress> {
  const attempts = await listPracticeAttempts(profileId, 500);
  const topicMap = new Map<
    PracticeTopic,
    { attempts: number; total: number; best: number }
  >();
  for (const item of PRACTICE_TOPICS) {
    topicMap.set(item.id, { attempts: 0, total: 0, best: 0 });
  }
  for (const attempt of attempts) {
    for (const topic of attempt.topics) {
      const current = topicMap.get(topic);
      if (!current) continue;
      current.attempts += 1;
      current.total += attempt.evaluation.scores.overall;
      current.best = Math.max(current.best, attempt.evaluation.scores.overall);
    }
  }

  const topics: PracticeProgressTopic[] = Array.from(topicMap.entries()).map(
    ([topic, value]) => ({
      topic,
      attempts: value.attempts,
      averageScore: value.attempts > 0 ? Math.round(value.total / value.attempts) : 0,
      bestScore: value.best,
    }),
  );

  const attempted = topics.filter((topic) => topic.attempts > 0);
  const unattempted = topics.filter((topic) => topic.attempts === 0);
  const recommended = [
    ...attempted
      .sort((a, b) => a.averageScore - b.averageScore)
      .map((topic) => topic.topic),
    ...unattempted.map((topic) => topic.topic),
  ].slice(0, 4);

  return {
    totalAttempts: attempts.length,
    averageScore:
      attempts.length > 0
        ? Math.round(
            attempts.reduce((sum, attempt) => sum + attempt.evaluation.scores.overall, 0) /
              attempts.length,
          )
        : 0,
    topics,
    recent: attempts.slice(0, 8),
    recommendedTopics: recommended,
  };
}
