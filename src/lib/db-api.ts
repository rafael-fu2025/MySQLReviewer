import type {
  AiReview,
  CharsetInfo,
  CreateDatabaseInput,
  CreateDatabaseResult,
  DatabaseObjects,
  ExplainResult,
  Finding,
  GrantSqlRequest,
  GrantSqlResult,
  HistoryEntry,
  PracticeAnswers,
  PracticeAttemptPublic,
  PracticeEvaluateRequest,
  PracticeEvaluation,
  PracticeProgressPublic,
  PracticeSetPublic,
  QueryResult,
  SavedReviewResult,
  Snippet,
  StaticReviewResult,
  TableDataRequest,
  TableDetail,
} from '@shared/types';
import { api } from './api';

/**
 * Thin browser-side client for the MyLens statement endpoints. The server is the
 * single execution boundary; this module never builds SQL by concatenation.
 */
export const dbApi = {
  run(
    profileId: string,
    statement: string,
    database: string | null,
    options: { revealSensitive?: boolean } = {},
  ): Promise<QueryResult> {
    const payload = {
      sql: statement,
      database,
      revealSensitive: options.revealSensitive === true,
    };
    return api.post<QueryResult>(
      `/api/db/${encodeURIComponent(profileId)}/query`,
      payload,
    );
  },

  explain(
    profileId: string,
    statement: string,
    database: string | null,
    analyze: boolean,
  ): Promise<ExplainResult> {
    const payload = { sql: statement, database, analyze };
    return api.post<ExplainResult>(
      `/api/db/${encodeURIComponent(profileId)}/explain`,
      payload,
    );
  },

  review(
    profileId: string,
    statement: string,
    database: string | null,
    includeExplain: boolean,
    includeSchema = true,
  ): Promise<StaticReviewResult> {
    const payload = {
      profileId,
      database,
      sql: statement,
      includeSchema,
      includeExplain,
    };
    return api.post<StaticReviewResult>('/api/review/static', payload);
  },

  saveReview(payload: {
    profileId: string | null;
    database: string | null;
    statement: string;
    includeExplain: boolean;
    ai: AiReview | null;
  }): Promise<SavedReviewResult> {
    return api.post('/api/review/save', {
      profileId: payload.profileId,
      database: payload.database,
      sql: payload.statement,
      includeExplain: payload.includeExplain,
      ai: payload.ai,
    });
  },

  aiReviewBody(payload: {
    profileId: string;
    database: string | null;
    statement: string;
    providerId: string;
    model: string;
    includeSchema: boolean;
    includeExplain: boolean;
    analyze: boolean;
    findings?: Finding[];
    explain?: ExplainResult | null;
  }): Record<string, unknown> {
    return {
      profileId: payload.profileId,
      database: payload.database,
      sql: payload.statement,
      providerId: payload.providerId,
      model: payload.model,
      includeSchema: payload.includeSchema,
      includeExplain: payload.includeExplain,
      analyze: payload.analyze,
      findings: payload.findings,
      explain: payload.explain,
    };
  },

  history(profileId: string, limit = 150): Promise<HistoryEntry[]> {
    return api.get<HistoryEntry[]>(
      `/api/history?profileId=${encodeURIComponent(profileId)}&limit=${limit}`,
    );
  },

  clearHistory(profileId: string): Promise<unknown> {
    return api.del(`/api/history?profileId=${encodeURIComponent(profileId)}`);
  },

  snippets(): Promise<Snippet[]> {
    return api.get<Snippet[]>('/api/snippets');
  },

  saveSnippet(title: string, statement: string, tags: string[]): Promise<Snippet> {
    return api.post<Snippet>('/api/snippets', { title, sql: statement, tags });
  },

  deleteSnippet(id: string): Promise<unknown> {
    return api.del(`/api/snippets/${encodeURIComponent(id)}`);
  },

  objects(profileId: string, database: string): Promise<DatabaseObjects> {
    return api.get<DatabaseObjects>(
      `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/objects`,
    );
  },

  tableDetail(profileId: string, database: string, table: string): Promise<TableDetail> {
    return api.get<TableDetail>(
      `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}`,
    );
  },

  tableData(
    profileId: string,
    database: string,
    table: string,
    payload: TableDataRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<QueryResult> {
    return api.post<QueryResult>(
      `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}/data`,
      payload,
      options,
    );
  },

  objectInfo(
    profileId: string,
    database: string,
    type: 'view' | 'routine' | 'trigger' | 'event',
    name: string,
    routineType?: 'FUNCTION' | 'PROCEDURE',
  ): Promise<Record<string, unknown>> {
    const query = routineType ? `?routineType=${routineType}` : '';
    return api.get<Record<string, unknown>>(
      `/api/db/${encodeURIComponent(profileId)}/objects/${encodeURIComponent(database)}/${type}/${encodeURIComponent(name)}${query}`,
    );
  },

  listCharsets(profileId: string): Promise<CharsetInfo[]> {
    return api.get<CharsetInfo[]>(
      `/api/db/${encodeURIComponent(profileId)}/charsets`,
    );
  },

  createDatabase(
    profileId: string,
    input: CreateDatabaseInput,
  ): Promise<CreateDatabaseResult> {
    return api.post<CreateDatabaseResult>(
      `/api/db/${encodeURIComponent(profileId)}/databases`,
      input,
    );
  },

  grantSql(profileId: string, input: GrantSqlRequest): Promise<GrantSqlResult> {
    return api.post<GrantSqlResult>(
      `/api/connections/${encodeURIComponent(profileId)}/grant-sql`,
      input,
    );
  },

  practiceSets(profileId: string, limit = 20): Promise<PracticeSetPublic[]> {
    return api.get<PracticeSetPublic[]>(
      `/api/practice/sets?profileId=${encodeURIComponent(profileId)}&limit=${limit}`,
    );
  },

  practiceAttempts(profileId: string, limit = 30): Promise<PracticeAttemptPublic[]> {
    return api.get<PracticeAttemptPublic[]>(
      `/api/practice/attempts?profileId=${encodeURIComponent(profileId)}&limit=${limit}`,
    );
  },

  practiceProgress(profileId: string): Promise<PracticeProgressPublic> {
    return api.get<PracticeProgressPublic>(
      `/api/practice/progress?profileId=${encodeURIComponent(profileId)}`,
    );
  },

  /**
   * Reference material is released only for questions this profile has already
   * attempted; the server filters the list, so the response never contains
   * answers for unattempted questions.
   */
  practiceAnswers(setId: string, profileId: string): Promise<PracticeAnswers> {
    return api.get<PracticeAnswers>(
      `/api/practice/sets/${encodeURIComponent(setId)}/answers?profileId=${encodeURIComponent(profileId)}`,
    );
  },

  practiceEvaluate(payload: PracticeEvaluateRequest): Promise<PracticeEvaluation> {
    return api.post<PracticeEvaluation>('/api/practice/evaluate', payload);
  },

  clearPracticeAttempts(profileId: string): Promise<unknown> {
    return api.del(
      `/api/practice/attempts?profileId=${encodeURIComponent(profileId)}`,
    );
  },
};
