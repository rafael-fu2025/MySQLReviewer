import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EditorView } from '@codemirror/view';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Flag,
  FlaskConical,
  Info,
  Lightbulb,
  ListChecks,
  PanelRight,
  PanelRightClose,
  RefreshCw,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  X,
  XCircle,
} from 'lucide-react';
import type {
  PracticeAnswer,
  PracticeComparison,
  PracticeDifficulty,
  PracticeEvaluation,
  PracticeProgressPublic,
  PracticeSetPublic,
  PracticeTopic,
  QueryResult,
} from '@shared/types';
import { PRACTICE_DIFFICULTIES, PRACTICE_TOPICS } from '@shared/types';
import { useAppStore, BOOT_PATH } from '@/store/app-store';
import { dbApi } from '@/lib/db-api';
import { postSse } from '@/lib/sse';
import { formatDate } from '@/lib/format';
import { SqlEditor } from '@/components/SqlEditor';
import { SchemaSidebar } from '@/components/SchemaSidebar';
import { Markdown } from '@/components/Markdown';
import { FindingsList } from '@/components/Findings';
import { ExplainPanel } from '@/components/ExplainPanel';
import { ResultsGrid } from '@/components/ResultsGrid';
import { Combobox, MultiSelect } from '@/components/Combobox';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  Modal,
  PageHeader,
  ScoreRing,
  Spinner,
  Textarea,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/hooks';

interface AnswerState {
  sql: string;
  answer: string;
  evaluation: PracticeEvaluation | null;
  /** True when the server matched an earlier identical submission. */
  duplicate?: boolean;
}

interface PracticeDraft {
  sql: string;
  answer: string;
}

const EMPTY_ANSWER: AnswerState = { sql: '', answer: '', evaluation: null };

/** Offered challenge counts; the server caps a request at 25. */
const CHALLENGE_COUNTS = [5, 10, 15, 20, 25];

const DRAFT_PREFIX = 'mylens.practice.draft';
const SCHEMA_PANEL_KEY = 'mylens.practice.schemaPanel';
const LAST_SET_PREFIX = 'mylens.practice.lastSet';

function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function readSchemaPanelOpen(): boolean {
  try {
    return sessionStorage.getItem(SCHEMA_PANEL_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function draftKey(profileId: string, setId: string): string {
  return `${DRAFT_PREFIX}.${profileId}.${setId}`;
}

function readDraft(profileId: string, setId: string): Record<string, PracticeDraft> {
  try {
    const raw = localStorage.getItem(draftKey(profileId, setId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const drafts: Record<string, PracticeDraft> = {};
    for (const [questionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const draft = value as Partial<PracticeDraft> | null;
      if (!draft || typeof draft.sql !== 'string' || typeof draft.answer !== 'string') continue;
      drafts[questionId] = { sql: draft.sql, answer: draft.answer };
    }
    return drafts;
  } catch {
    return {};
  }
}

function writeDraft(profileId: string, setId: string, drafts: Record<string, PracticeDraft>): void {
  try {
    const key = draftKey(profileId, setId);
    if (Object.keys(drafts).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(drafts));
  } catch {
    // Storage can be unavailable (private mode, quota); drafts are best-effort.
  }
}

function lastSetKey(profileId: string): string {
  return `${LAST_SET_PREFIX}.${profileId}`;
}

/** The set that was open last, so a reload lands on the same challenge set. */
function readLastSetId(profileId: string): string | null {
  try {
    return localStorage.getItem(lastSetKey(profileId));
  } catch {
    return null;
  }
}

function writeLastSetId(profileId: string, setId: string | null): void {
  try {
    const key = lastSetKey(profileId);
    if (setId) localStorage.setItem(key, setId);
    else localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode, quota); the restore is a convenience.
  }
}

function CodeBlock({ text, className }: { text: string; className?: string }) {
  return <pre className={cn('code-block', className)}>{text}</pre>;
}

/** The saved challenge sets, so a previous one can be picked up again. */
function RecentSetsCard({
  sets,
  onPick,
}: {
  sets: PracticeSetPublic[];
  onPick: (item: PracticeSetPublic) => void;
}) {
  if (sets.length === 0) return null;
  return (
    <Card className="p-4">
      <div className="section-title mb-2">Recent challenge sets</div>
      <div className="flex flex-col gap-1.5">
        {sets.map((item) => (
          <button
            key={item.id}
            type="button"
            className="flex items-center gap-2 rounded-lg border border-line-soft bg-panel-2/40 px-2.5 py-2 text-left hover:border-ember/35"
            onClick={() => onPick(item)}
          >
            <FlaskConical size={13} className="text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] text-ink-soft">
                {item.database} · {item.questions.length} challenges
              </span>
              <span className="block text-[10px] text-muted">{formatDate(item.createdAt)}</span>
            </span>
            <Badge tone="neutral">{item.model}</Badge>
          </button>
        ))}
      </div>
    </Card>
  );
}

function topicLabel(topic: PracticeTopic): string {
  return PRACTICE_TOPICS.find((item) => item.id === topic)?.label ?? topic;
}

function verdictTone(
  verdict: PracticeEvaluation['verdict'],
): 'mint' | 'warn' | 'danger' | 'neutral' {
  if (verdict === 'correct') return 'mint';
  if (verdict === 'close') return 'warn';
  if (verdict === 'incorrect') return 'danger';
  return 'neutral';
}

function ComparisonView({ comparison }: { comparison: PracticeComparison }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={comparison.matched ? 'mint' : 'warn'}>
          {comparison.matched ? 'results match' : 'results differ'}
        </Badge>
        <Badge tone="neutral">{comparison.ordered ? 'order matters' : 'order ignored'}</Badge>
        {comparison.truncated ? <Badge tone="warn">row cap reached</Badge> : null}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="stat">
          <div className="stat-label">Your rows</div>
          <div className="stat-value">{comparison.userRowCount ?? '—'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Reference rows</div>
          <div className="stat-value">{comparison.referenceRowCount ?? '—'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Matched</div>
          <div className="stat-value text-mint">{comparison.matchedRows}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Unmatched</div>
          <div className="stat-value text-warn">{comparison.unmatchedRows}</div>
        </div>
      </div>
      <div className="text-[11px] text-muted">{comparison.reason}</div>
      {comparison.missingRows.length > 0 || comparison.extraRows.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {comparison.missingRows.length > 0 ? (
            <div>
              <div className="mono-label mb-1">Missing rows (sample)</div>
              <pre className="finding-evidence">
                {JSON.stringify(comparison.missingRows, null, 2)}
              </pre>
            </div>
          ) : null}
          {comparison.extraRows.length > 0 ? (
            <div>
              <div className="mono-label mb-1">Extra rows (sample)</div>
              <pre className="finding-evidence">
                {JSON.stringify(comparison.extraRows, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function PracticePage() {
  const navigate = useNavigate();
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const selectedDatabase = useAppStore((state) => state.selectedDatabase);
  const databases = useAppStore((state) => state.databases);
  const setDatabase = useAppStore((state) => state.setDatabase);
  const schema = useAppStore((state) => state.schema);
  const refreshSchema = useAppStore((state) => state.refreshSchema);
  const providers = useAppStore((state) => state.providers);
  const settings = useAppStore((state) => state.settings);
  const toast = useAppStore((state) => state.toast);

  const defaultProvider =
    providers.find((provider) => provider.id === settings.defaultAiProviderId) ??
    providers.find((provider) => provider.isDefault) ??
    providers[0] ??
    null;

  const [tables, setTables] = useState<string[]>([]);
  const [topics, setTopics] = useState<PracticeTopic[]>(['select', 'joins', 'aggregation']);
  const [difficulty, setDifficulty] = useState<PracticeDifficulty | 'mixed'>('mixed');
  const [count, setCount] = useState(5);
  const [providerId, setProviderId] = useState(defaultProvider?.id ?? '');
  const [model, setModel] = useState(defaultProvider?.model ?? '');
  const [includeSampleData, setIncludeSampleData] = useState(false);
  const [includeAi, setIncludeAi] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generationText, setGenerationText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [practiceSet, setPracticeSet] = useState<PracticeSetPublic | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [answerMaterial, setAnswerMaterial] = useState<Record<string, PracticeAnswer>>({});
  const [hintsShown, setHintsShown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<QueryResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [progress, setProgress] = useState<PracticeProgressPublic | null>(null);
  const [recentSets, setRecentSets] = useState<PracticeSetPublic[]>([]);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(true);
  const [flagged, setFlagged] = useState<Record<string, boolean>>({});
  // lg+ renders the schema panel inline; below lg it is an overlay drawer.
  const [schemaPanelOpen, setSchemaPanelOpen] = useState<boolean>(readSchemaPanelOpen);
  const [schemaDrawerOpen, setSchemaDrawerOpen] = useState(false);
  const isLargeViewport = useMediaQuery('(min-width: 1024px)');
  const editorView = useRef<EditorView | null>(null);
  const generationAbort = useRef<AbortController | null>(null);
  const runRequest = useRef(0);
  // Which set the answers/reference request belongs to; a response for a set
  // that is no longer open must never be applied.
  const activeSetId = useRef<string | null>(null);
  // Which set already had its drafts read, so the writer never races the reader.
  const persistedSetId = useRef<string | null>(null);

  const question = practiceSet?.questions[activeIndex] ?? null;
  const current = question ? (answers[question.id] ?? EMPTY_ANSWER) : EMPTY_ANSWER;
  const evaluation = current.evaluation;
  const flaggedCurrent = question ? Boolean(flagged[question.id]) : false;
  // Released by the server only for questions this profile has already attempted.
  const reference = question ? answerMaterial[question.id] : undefined;
  const pinnedDatabase = practiceSet?.database ?? selectedDatabase;
  const databaseMismatch = Boolean(practiceSet && practiceSet.database !== selectedDatabase);
  const schemaPanelVisible = isLargeViewport ? schemaPanelOpen : schemaDrawerOpen;

  const toggleSchemaPanel = useCallback((): void => {
    if (isLargeViewport) setSchemaPanelOpen((value) => !value);
    else setSchemaDrawerOpen((value) => !value);
  }, [isLargeViewport]);

  // Remember the inline panel state for the rest of the browser session.
  useEffect(() => {
    try {
      sessionStorage.setItem(SCHEMA_PANEL_KEY, schemaPanelOpen ? 'open' : 'closed');
    } catch {
      // Session storage is best-effort (private mode); the panel still works.
    }
  }, [schemaPanelOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSchemaPanel();
        return;
      }
      if (event.key === 'Escape' && schemaDrawerOpen && !isLargeViewport) {
        setSchemaDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isLargeViewport, schemaDrawerOpen, toggleSchemaPanel]);

  // The challenge view is three columns: the challenge itself (brief, editor,
  // result), the database tables and the question tracker. The tables and the
  // tracker keep their own width on the right, and the tree scrolls inside the
  // table panel instead of resizing the editor.
  const stageColumns = cn(
    'grid grid-cols-1 gap-4',
    schemaPanelOpen && navigatorOpen && 'lg:grid-cols-[minmax(0,1fr)_300px_224px]',
    schemaPanelOpen && !navigatorOpen && 'lg:grid-cols-[minmax(0,1fr)_300px]',
    !schemaPanelOpen && navigatorOpen && 'lg:grid-cols-[minmax(0,1fr)_224px]',
    !schemaPanelOpen && !navigatorOpen && 'lg:grid-cols-[minmax(0,1fr)]',
  );

  const answeredCount = useMemo(
    () =>
      practiceSet
        ? practiceSet.questions.filter((item) => Boolean(answers[item.id]?.evaluation)).length
        : 0,
    [answers, practiceSet],
  );
  const tableOptions = useMemo(
    () =>
      (schema?.tables ?? []).map((table) => ({
        value: table.name,
        label: table.name,
        description: `${table.columns.length} columns`,
        group: 'Tables',
      })),
    [schema],
  );
  const providerOptions = providers.map((provider) => ({
    value: provider.id,
    label: provider.name,
    description: `${provider.type} · ${provider.model}`,
    group: 'Providers',
  }));

  useEffect(() => {
    if (selectedDatabase && !schema) void refreshSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDatabase]);

  // Tables belong to one database; drop the selection when it changes. The
  // state is adjusted while rendering so the stale table list is never used.
  const [tablesDatabase, setTablesDatabase] = useState(selectedDatabase);
  if (tablesDatabase !== selectedDatabase) {
    setTablesDatabase(selectedDatabase);
    setTables([]);
  }

  // Adopt the default provider as soon as the provider list is available.
  if (!providerId && defaultProvider) {
    setProviderId(defaultProvider.id);
    setModel(defaultProvider.model);
  }

  useEffect(() => {
    if (!activeProfileId) return;
    void dbApi
      .practiceProgress(activeProfileId)
      .then(setProgress)
      .catch(() => undefined);
    void dbApi
      .practiceSets(activeProfileId, 5)
      .then(setRecentSets)
      .catch(() => undefined);
  }, [activeProfileId]);

  // A new question starts without hints and without the previous run result.
  // The state is adjusted while rendering so the panel never shows results
  // that belong to another question.
  const [hintedQuestionId, setHintedQuestionId] = useState(question?.id);
  if (hintedQuestionId !== question?.id) {
    setHintedQuestionId(question?.id);
    setHintsShown(0);
    setRunResult(null);
    setRunError(null);
  }

  // Restore unsubmitted drafts when a set becomes active (for example after a
  // reload and reopening it from the recent list). The drafts are read while
  // rendering and merged in the same commit as the set change.
  const [restoredDrafts, setRestoredDrafts] = useState<{
    profileId: string;
    set: PracticeSetPublic;
  } | null>(null);
  if (
    activeProfileId &&
    practiceSet &&
    (restoredDrafts?.profileId !== activeProfileId || restoredDrafts?.set !== practiceSet)
  ) {
    setRestoredDrafts({ profileId: activeProfileId, set: practiceSet });
    const stored = readDraft(activeProfileId, practiceSet.id);
    if (Object.keys(stored).length > 0) {
      setAnswers((previous) => {
        const next = { ...previous };
        for (const [questionId, draft] of Object.entries(stored)) {
          if (next[questionId]?.evaluation) continue;
          next[questionId] = { ...(next[questionId] ?? EMPTY_ANSWER), ...draft };
        }
        return next;
      });
    }
  }

  // Persist only unanswered text: once a question is graded the server owns the
  // attempt and the local draft is cleared.
  useEffect(() => {
    if (!activeProfileId || !practiceSet) return;
    if (persistedSetId.current !== practiceSet.id) {
      // First commit after the set was opened: the restore effect has queued the
      // stored drafts but they are not in `answers` yet, so writing now would
      // erase them.
      persistedSetId.current = practiceSet.id;
      return;
    }
    const drafts: Record<string, PracticeDraft> = {};
    for (const [questionId, value] of Object.entries(answers)) {
      if (value.evaluation) continue;
      if (!value.sql.trim() && !value.answer.trim()) continue;
      drafts[questionId] = { sql: value.sql, answer: value.answer };
    }
    writeDraft(activeProfileId, practiceSet.id, drafts);
  }, [activeProfileId, practiceSet, answers]);

  const updateCurrent = (patch: Partial<AnswerState>): void => {
    if (!question) return;
    setAnswers((previous) => ({
      ...previous,
      [question.id]: { ...(previous[question.id] ?? EMPTY_ANSWER), ...patch },
    }));
  };

  const loadAnswers = async (setId: string): Promise<void> => {
    if (!activeProfileId) return;
    try {
      const payload = await dbApi.practiceAnswers(setId, activeProfileId);
      if (activeSetId.current !== setId) return;
      setAnswerMaterial(Object.fromEntries(payload.answers.map((item) => [item.questionId, item])));
    } catch {
      // Reference material is supplementary; grading already happened.
    }
  };

  /**
   * Rebuild the answered state of a set from the recorded attempts. The server
   * owns the graded answers, so a reload has to bring them back instead of
   * leaving only the generated questions.
   */
  const loadAttempts = async (setId: string): Promise<void> => {
    if (!activeProfileId) return;
    try {
      const attempts = await dbApi.practiceSetAttempts(setId, activeProfileId);
      if (activeSetId.current !== setId) return;
      setAnswers((previous) => {
        const next = { ...previous };
        // Attempts are stored newest first, so the first hit for a question is
        // its most recent grade. A grade made in this session wins over it.
        for (const attempt of attempts) {
          if (next[attempt.questionId]?.evaluation) continue;
          next[attempt.questionId] = {
            sql: attempt.userSql,
            answer: attempt.userAnswer,
            evaluation: {
              ...attempt.evaluation,
              referenceSql: null,
              referenceResult: null,
            },
          };
        }
        return next;
      });
    } catch {
      // The recorded grades are supplementary; the set still works without them.
    }
  };

  const activateSet = (next: PracticeSetPublic | null): void => {
    activeSetId.current = next?.id ?? null;
    persistedSetId.current = null;
    setPracticeSet(next);
    setActiveIndex(0);
    setAnswers({});
    setAnswerMaterial({});
    setFlagged({});
    setHintsShown(0);
    setRunResult(null);
    setRunError(null);
    // Grading is pinned to the set's database, so the top bar and the schema
    // panel have to follow it. A set owned by another profile is never allowed
    // to move the selection (ownership is enforced by the server too).
    if (next && next.profileId === activeProfileId && next.database !== selectedDatabase) {
      if (databases.some((database) => database.name === next.database)) {
        // setDatabase also refreshes the schema and objects for that database.
        setDatabase(next.database);
      } else {
        toast(
          `The database "${next.database}" is no longer available on this connection. The challenge set stays open, but the database was not switched.`,
          'warn',
        );
      }
    }
    if (next) {
      // Remember the set per connection so a reload lands on the same set with
      // its graded answers.
      writeLastSetId(activeProfileId ?? next.profileId, next.id);
      void loadAnswers(next.id);
      void loadAttempts(next.id);
    }
  };

  // Restore the set that was open last. Without this the answered questions
  // would only come back after the set is picked from the recent list again.
  // Only a reload of the practice page restores it: jumping to SQL Lab from
  // somewhere else lands on the hub, so a new set can still be generated.
  const restoredSetProfile = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProfileId || practiceSet) return;
    if (restoredSetProfile.current === activeProfileId) return;
    restoredSetProfile.current = activeProfileId;
    if (BOOT_PATH !== '/practice') return;
    const lastId = readLastSetId(activeProfileId);
    if (!lastId) return;
    void dbApi
      .practiceSets(activeProfileId, 50)
      .then((sets) => {
        const found = sets.find((item) => item.id === lastId);
        if (found) activateSet(found);
      })
      .catch(() => undefined);
    // `activateSet` changes on every render; the guard above keeps it to one
    // restore per connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileId, practiceSet]);

  const loadProgress = async (): Promise<void> => {
    if (!activeProfileId) return;
    try {
      setProgress(await dbApi.practiceProgress(activeProfileId));
      setRecentSets(await dbApi.practiceSets(activeProfileId, 5));
    } catch {
      // Supplementary UI.
    }
  };

  // The saved sets are listed on the hub, so they have to be there before the
  // setup modal is opened.
  useEffect(() => {
    if (!activeProfileId) return;
    void dbApi
      .practiceSets(activeProfileId, 5)
      .then((sets) => setRecentSets(sets))
      .catch(() => undefined);
  }, [activeProfileId]);

  const generate = async (): Promise<void> => {
    if (!activeProfileId || !selectedDatabase) {
      toast('Select a database first.', 'warn');
      return;
    }
    if (topics.length === 0) {
      toast('Select at least one topic.', 'warn');
      return;
    }
    if (!providerId) {
      toast('Add or select an AI provider in Settings first.', 'warn');
      return;
    }
    generationAbort.current?.abort();
    const controller = new AbortController();
    generationAbort.current = controller;
    setGenerating(true);
    setGenerationText('');
    setError(null);
    try {
      await postSse(
        '/api/practice/generate',
        {
          profileId: activeProfileId,
          database: selectedDatabase,
          tables,
          topics,
          difficulty,
          count,
          providerId,
          model,
          includeSampleData,
        },
        {
          onEvent: ({ event, data }) => {
            if (event === 'delta') {
              const payload = data as { text?: string };
              if (payload.text) setGenerationText((currentText) => currentText + payload.text);
            } else if (event === 'result') {
              const payload = data as { set?: PracticeSetPublic };
              if (payload.set) {
                activateSet(payload.set);
                setSetupOpen(false);
                void loadProgress();
              }
            } else if (event === 'error') {
              const payload = data as { message?: string };
              setError(payload.message ?? 'Challenge generation failed.');
            }
          },
          onError: (err) => {
            setError(err instanceof Error ? err.message : String(err));
          },
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setGenerating(false);
      generationAbort.current = null;
    }
  };

  const cancelGeneration = (): void => {
    generationAbort.current?.abort();
    generationAbort.current = null;
    setGenerating(false);
    toast('Generation cancelled.', 'info');
  };

  const openSetup = (): void => {
    setSetupOpen(true);
  };

  const closeSetup = (): void => {
    if (generating) {
      generationAbort.current?.abort();
      generationAbort.current = null;
      setGenerating(false);
    }
    setSetupOpen(false);
  };

  const toggleFlag = (questionId: string): void => {
    setFlagged((previous) => ({ ...previous, [questionId]: !previous[questionId] }));
  };

  const evaluate = async (): Promise<void> => {
    if (!activeProfileId || !practiceSet || !question) return;
    if (!current.sql.trim() && !current.answer.trim()) {
      toast('Write an answer before submitting.', 'warn');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await dbApi.practiceEvaluate({
        profileId: activeProfileId,
        setId: practiceSet.id,
        questionId: question.id,
        userSql: current.sql.trim() || undefined,
        userAnswer: current.answer.trim() || undefined,
        providerId: includeAi ? providerId || undefined : undefined,
        model: includeAi ? model || undefined : undefined,
        includeAi: Boolean(includeAi && providerId),
      });
      if (result.duplicate) {
        // The server recognised an identical resubmission and did not record a
        // new attempt, so no progress counter changes here either.
        updateCurrent({ evaluation: result, duplicate: true });
        void loadAnswers(practiceSet.id);
        toast(
          'Already submitted — this answer was recorded earlier and was not counted again.',
          'info',
        );
        return;
      }
      updateCurrent({ evaluation: result, duplicate: false });
      void loadProgress();
      void loadAnswers(practiceSet.id);
      toast(
        result.verdict === 'correct'
          ? 'Correct. Nicely done.'
          : result.verdict === 'close'
            ? 'Close. Review the differences and try again.'
            : 'Answer reviewed. Read the feedback and reference.',
        result.verdict === 'correct' ? 'success' : result.verdict === 'close' ? 'info' : 'warn',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Run is an execution preview, not a submission: it never records an attempt.
   * Submit is the only path that grades.
   */
  const runQuery = async (sql: string): Promise<void> => {
    if (!activeProfileId || !selectedDatabase) return;
    const text = sql.trim();
    if (!text) {
      toast('Write a query before running it.', 'warn');
      return;
    }
    const requestId = runRequest.current + 1;
    runRequest.current = requestId;
    setRunning(true);
    setRunError(null);
    try {
      const result = await dbApi.run(activeProfileId, text, pinnedDatabase ?? selectedDatabase);
      if (runRequest.current !== requestId) return;
      setRunResult(result);
    } catch (err) {
      if (runRequest.current !== requestId) return;
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      if (runRequest.current === requestId) setRunning(false);
    }
  };

  /**
   * Schema clicks land at the caret of the live editor when it is mounted;
   * otherwise the identifier is appended to the stored draft so nothing is lost.
   */
  const insertFromSchema = (text: string): void => {
    const view = editorView.current;
    if (view && view.dom.isConnected) {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
      return;
    }
    const base = current.sql;
    const separator = base.length > 0 && !/\s$/.test(base) ? ' ' : '';
    updateCurrent({ sql: `${base}${separator}${text}` });
  };

  /** Preview only: the statement runs read-only and never records an attempt. */
  const previewTable = (table: string): void => {
    void runQuery(`SELECT * FROM ${quoteIdentifier(table)} LIMIT 5`);
  };

  const goTo = (index: number): void => {
    if (!practiceSet) return;
    setActiveIndex(Math.max(0, Math.min(practiceSet.questions.length - 1, index)));
  };

  const clearAttempts = async (): Promise<void> => {
    if (!activeProfileId) return;
    try {
      await dbApi.clearPracticeAttempts(activeProfileId);
      setClearConfirm(false);
      setAnswerMaterial({});
      // The server is the source of truth for graded answers, so the client
      // drops them too. The text stays and is kept as a draft.
      setAnswers((previous) => {
        const next: Record<string, AnswerState> = {};
        for (const [questionId, value] of Object.entries(previous)) {
          next[questionId] = { ...value, evaluation: null, duplicate: false };
        }
        return next;
      });
      await loadProgress();
      toast('Practice attempts cleared.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  if (!activeProfileId || !selectedDatabase) {
    return (
      <div className="page">
        <PageHeader
          title="SQL Lab"
          subtitle="Reviewer-style challenges generated from your own schema."
        />
        <EmptyState
          icon={<FlaskConical size={24} />}
          title="Select a database first"
          copy="Choose a database in the top bar. SQL Lab uses its schema to generate grounded challenges."
        />
      </div>
    );
  }

  return (
    <div className={cn('page', !practiceSet && 'page-centered')}>
      {practiceSet ? (
        <div className="practice-toolbar">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <FlaskConical size={17} className="shrink-0 text-ember" />
            <span className="practice-toolbar-title">SQL Lab</span>
            <Badge tone="mint">
              <Target size={10} /> {practiceSet.database}
            </Badge>
            <span className="truncate text-[10.5px] text-muted">
              {answeredCount}/{practiceSet.questions.length} answered
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<ListChecks size={12} />}
              onClick={() => setNavigatorOpen((value) => !value)}
            >
              {navigatorOpen ? 'Hide questions' : 'Questions'}
            </Button>
            <Button variant="secondary" size="sm" icon={<Sparkles size={12} />} onClick={openSetup}>
              New challenges
            </Button>
          </div>
        </div>
      ) : (
        <PageHeader
          title="SQL Lab"
          subtitle="Generate reviewer-style problems, answer them, and compare with a reference solution. SQL answers run read-only; DML/DDL and concept answers are graded without execution."
          actions={
            <>
              <Badge tone="mint">
                <Target size={10} /> {selectedDatabase}
              </Badge>
              {/*
               * The empty state below already carries the primary "Generate
               * challenges" action, so the header keeps a secondary shortcut
               * rather than a second orange button for the same thing.
               */}
              <Button
                variant="secondary"
                size="sm"
                icon={<Sparkles size={12} />}
                onClick={openSetup}
              >
                Generate challenges
              </Button>
            </>
          }
        />
      )}

      {error ? (
        <div className="callout danger flex items-start gap-2">
          <XCircle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {databaseMismatch ? (
        <div className="callout warn flex items-start gap-2">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>
            This challenge set belongs to <strong>{practiceSet?.database}</strong>. Answers are
            graded against that database; generate a new set to practise on{' '}
            <strong>{selectedDatabase}</strong>.
          </span>
        </div>
      ) : null}

      <div className="practice-stage">
        <Modal
          open={setupOpen}
          onClose={closeSetup}
          title="SQL Lab setup"
          subtitle={`${selectedDatabase} · ${providers.length} provider${providers.length === 1 ? '' : 's'} configured`}
          size="wide"
        >
          <div className="practice-setup-grid">
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <FlaskConical size={15} className="text-ember" />
                <div className="section-title">Generate a challenge set</div>
              </div>
              {providers.length === 0 ? (
                <div className="callout info mb-3 flex flex-wrap items-center gap-2">
                  <Sparkles size={14} />
                  <span className="flex-1">Add an AI provider to generate challenges.</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigate('/settings?tab=ai')}
                  >
                    Configure AI
                  </Button>
                </div>
              ) : null}

              <div className="flex flex-col gap-3">
                <Field
                  label="Tables"
                  hint={
                    tableOptions.length === 0
                      ? 'Schema is loading. Open the Database page if this persists.'
                      : 'Leave empty to use up to 20 tables selected by size.'
                  }
                >
                  <MultiSelect
                    options={tableOptions}
                    values={tables}
                    onChange={setTables}
                    placeholder="All tables (up to 20)"
                    searchPlaceholder="Search tables…"
                    showSelectAll
                  />
                </Field>

                <Field label="Topics">
                  <MultiSelect
                    options={PRACTICE_TOPICS.map((topic) => ({
                      value: topic.id,
                      label: topic.label,
                      group: 'Topics',
                    }))}
                    values={topics}
                    onChange={(values) => setTopics(values as PracticeTopic[])}
                    placeholder="Choose topics…"
                    searchPlaceholder="Search topics…"
                    showSelectAll
                  />
                </Field>

                <div className="grid grid-cols-2 gap-2">
                  <Field label="Difficulty">
                    <Combobox
                      options={PRACTICE_DIFFICULTIES.map((item) => ({
                        value: item.id,
                        label: item.label,
                      }))}
                      value={difficulty}
                      onChange={(value) => setDifficulty(value as PracticeDifficulty | 'mixed')}
                      clearable={false}
                    />
                  </Field>
                  <Field label="Challenges">
                    <Combobox
                      options={CHALLENGE_COUNTS.map((value) => ({
                        value: String(value),
                        label: String(value),
                      }))}
                      value={String(count)}
                      onChange={(value) => setCount(Number(value))}
                      clearable={false}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="Provider">
                    <Combobox
                      options={providerOptions}
                      value={providerId || null}
                      onChange={(value) => {
                        setProviderId(value);
                        const next = providers.find((provider) => provider.id === value);
                        if (next) setModel(next.model);
                      }}
                      placeholder={providers.length ? 'Select provider…' : 'No providers'}
                      clearable={false}
                      disabled={providers.length === 0}
                    />
                  </Field>
                  <Field label="Model">
                    <Input
                      className="font-mono text-[11px]"
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder="model"
                      list="practice-models"
                    />
                    <datalist id="practice-models">
                      {(providers.find((provider) => provider.id === providerId)?.models ?? []).map(
                        (item) => (
                          <option key={item} value={item} />
                        ),
                      )}
                    </datalist>
                  </Field>
                </div>

                <Checkbox
                  label="Include a few masked sample rows"
                  checked={includeSampleData}
                  onChange={setIncludeSampleData}
                />
                <Checkbox
                  label="Use AI feedback after deterministic grading"
                  checked={includeAi}
                  onChange={setIncludeAi}
                />

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    className="flex-1"
                    icon={generating ? <Spinner size={12} /> : <Sparkles size={13} />}
                    onClick={() => void generate()}
                    loading={generating}
                    disabled={providers.length === 0 || topics.length === 0}
                  >
                    Generate challenges
                  </Button>
                  {generating ? (
                    <Button variant="ghost" size="sm" onClick={cancelGeneration}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
                <div className="text-[10px] leading-4 text-muted">
                  Challenges are grounded in the selected schema. The reference SQL is validated
                  read-only before it is accepted. Nothing in the database is modified.
                </div>
                {error ? (
                  <div className="callout danger flex items-start gap-2 text-[11px]">
                    <XCircle size={13} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                ) : null}
                {generating ? (
                  <div className="rounded-xl border border-line-soft bg-panel-2/50 p-3">
                    <div className="flex items-center gap-2 text-[11px] text-muted">
                      <Spinner size={13} />
                      Designing challenges from {selectedDatabase}…
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={cancelGeneration}
                      >
                        Stop
                      </Button>
                    </div>
                    {generationText ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[10px] text-muted">
                          Raw stream
                        </summary>
                        <pre className="finding-evidence mt-1 max-h-40 whitespace-pre-wrap">
                          {generationText.slice(-4_000)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Card>

            <div className="practice-setup-side">
              <Card className="p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Trophy size={14} className="text-ember" />
                  <div className="section-title">Progress</div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    icon={<RefreshCw size={11} />}
                    onClick={() => void loadProgress()}
                  >
                    Refresh
                  </Button>
                </div>
                {progress && progress.totalAttempts > 0 ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{progress.totalAttempts} attempts</Badge>
                      <Badge tone="mint">avg {progress.averageScore}</Badge>
                    </div>
                    {progress.recommendedTopics.length > 0 ? (
                      <div>
                        <div className="mono-label mb-1">Recommended next</div>
                        <div className="flex flex-wrap gap-1">
                          {progress.recommendedTopics.map((topic) => (
                            <Badge key={topic} tone="ember">
                              {topicLabel(topic)}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="flex flex-col gap-1.5">
                      {progress.topics
                        .filter((topic) => topic.attempts > 0)
                        .sort((a, b) => b.attempts - a.attempts)
                        .slice(0, 8)
                        .map((topic) => (
                          <div key={topic.topic}>
                            <div className="flex items-center justify-between gap-2 text-[10.5px]">
                              <span className="truncate text-ink-soft">
                                {topicLabel(topic.topic)}
                              </span>
                              <span className="font-mono text-muted">
                                {topic.averageScore} · {topic.attempts}×
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-3">
                              <div
                                className={cn(
                                  'h-full rounded-full',
                                  topic.averageScore >= 80
                                    ? 'bg-mint'
                                    : topic.averageScore >= 60
                                      ? 'bg-warn'
                                      : 'bg-danger',
                                )}
                                style={{ width: `${Math.max(3, topic.averageScore)}%` }}
                              />
                            </div>
                          </div>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        icon={<Trash2 size={11} />}
                        onClick={() => setClearConfirm(true)}
                      >
                        Clear attempts
                      </Button>
                      {progress.recent.length > 0 ? (
                        <span className="text-[10px] text-muted">
                          last {formatDate(progress.recent[0].createdAt)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="text-[11px] text-muted">
                    Your topic mastery appears here after you submit answers. The lab tracks
                    attempts locally for this connection.
                  </div>
                )}
              </Card>

              <RecentSetsCard
                sets={recentSets}
                onPick={(item) => {
                  activateSet(item);
                  setSetupOpen(false);
                }}
              />
            </div>
          </div>
        </Modal>

        <div className="practice-main">
          {!practiceSet ? (
            <>
              <EmptyState
                icon={<Target size={26} />}
                title="No challenge set yet"
                copy="Choose tables and topics, then generate a set. You can answer with SQL or a written explanation, depending on the challenge."
                action={
                  <Button variant="primary" icon={<Sparkles size={13} />} onClick={openSetup}>
                    Generate challenges
                  </Button>
                }
              />
              <div className="mt-3">
                <RecentSetsCard sets={recentSets} onPick={(item) => activateSet(item)} />
              </div>
            </>
          ) : question ? (
            <>
              {/*
               * The challenge workspace is three columns: the challenge itself
               * (brief, editor, result), the database tables and the question
               * tracker. The tables and the tracker stay pinned to the right.
               */}
              <div className={stageColumns}>
                <div className="flex min-w-0 flex-col gap-3">
                  <Card className="p-4 practice-question">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="ember">
                        {activeIndex + 1} / {practiceSet.questions.length}
                      </Badge>
                      <Badge tone="neutral">{question.type.replace('-', ' ')}</Badge>
                      <Badge
                        tone={
                          question.difficulty === 'easy'
                            ? 'mint'
                            : question.difficulty === 'hard'
                              ? 'danger'
                              : 'warn'
                        }
                      >
                        {question.difficulty}
                      </Badge>
                      {question.topics.map((topic) => (
                        <Badge key={topic} tone="neutral">
                          {topicLabel(topic)}
                        </Badge>
                      ))}
                      {flaggedCurrent ? (
                        <Badge tone="warn">
                          <Flag size={9} /> flagged
                        </Badge>
                      ) : null}
                      <span className="ml-auto text-[10px] text-muted">
                        ~{question.estimatedMinutes} min · {question.schemaTables.join(', ')}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-pressed={schemaPanelVisible}
                        title="Toggle schema browser (Ctrl/Cmd+B)"
                        icon={<PanelRight size={12} />}
                        onClick={toggleSchemaPanel}
                      >
                        Schema
                        <span className="hidden xl:inline-flex">
                          <Kbd>Ctrl B</Kbd>
                        </span>
                      </Button>
                    </div>

                    <h2 className="mt-3 text-[19px] font-extrabold tracking-tight">
                      {question.title}
                    </h2>
                    <div className="mt-2 whitespace-pre-wrap text-[12.5px] leading-6 text-ink-soft">
                      {question.scenario}
                    </div>

                    {question.brokenSql ? (
                      <div className="mt-3">
                        <div className="mono-label mb-1">
                          {question.type === 'fix-query'
                            ? 'Broken / inefficient query'
                            : 'Query to review'}
                        </div>
                        <CodeBlock text={question.brokenSql} className="max-h-52 text-[11px]" />
                      </div>
                    ) : null}

                    {question.hints.length > 0 ? (
                      <div className="mt-2 rounded-lg border border-warn/20 bg-warn/5 px-2.5 py-1.5">
                        <div className="flex items-center gap-2">
                          <Lightbulb size={11} className="text-warn" />
                          <span className="text-[10.5px] font-semibold tracking-wide text-warn uppercase">
                            Hints
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-auto h-6 px-2 text-[10.5px]"
                            onClick={() =>
                              setHintsShown((value) => Math.min(question.hints.length, value + 1))
                            }
                            disabled={hintsShown >= question.hints.length}
                          >
                            {hintsShown === 0 ? 'Show a hint' : 'Another hint'}
                          </Button>
                        </div>
                        {question.hints.slice(0, hintsShown).map((hint, index) => (
                          <div key={index} className="mt-1 text-[11px] leading-5 text-ink-soft">
                            {index + 1}. {hint}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </Card>

                  {question.type === 'write-query' || question.type === 'fix-query' ? (
                    <div className="min-h-[280px] flex-1 overflow-hidden rounded-xl border border-line-soft bg-canvas/40">
                      <SqlEditor
                        value={current.sql}
                        onChange={(value) => updateCurrent({ sql: value })}
                        schema={schema}
                        profileId={activeProfileId}
                        database={pinnedDatabase}
                        liveLint={settings.liveLint}
                        onRun={() => void runQuery(current.sql)}
                        onRunSelection={() => void runQuery(current.sql)}
                        onReview={() => undefined}
                        onReady={(view) => {
                          editorView.current = view;
                        }}
                      />
                    </div>
                  ) : (
                    <div className="min-h-[280px] flex-1 overflow-hidden rounded-xl border border-line-soft bg-canvas/40 p-3">
                      <Field
                        label={
                          question.type === 'review-query'
                            ? 'Explain the issues you find'
                            : 'Your answer, design notes, or explanation'
                        }
                      >
                        <Textarea
                          className="min-h-[220px]"
                          value={current.answer}
                          onChange={(event) => updateCurrent({ answer: event.target.value })}
                          placeholder={
                            question.type === 'review-query'
                              ? 'List the problems, why they matter, and how you would fix them…'
                              : 'Write your reasoning and any SQL/DDL you would use…'
                          }
                        />
                      </Field>
                    </div>
                  )}

                  {runError ? <div className="callout danger">{runError}</div> : null}
                  {runResult ? (
                    <details open className="rounded-xl border border-line-soft bg-panel-2/40 p-2">
                      <summary className="cursor-pointer px-1 py-1 text-[11px] font-semibold text-muted">
                        Query result · {runResult.rowCount} rows · {runResult.executionMs} ms
                      </summary>
                      <div className="mt-1 max-h-[320px] overflow-auto rounded-lg border border-line-soft">
                        <ResultsGrid result={runResult} />
                      </div>
                    </details>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="primary"
                      icon={submitting ? <Spinner size={12} /> : <CheckCircle2 size={13} />}
                      onClick={() => void evaluate()}
                      loading={submitting}
                    >
                      Submit answer
                    </Button>
                    {question.type === 'review-query' || question.type === 'concept' ? null : (
                      <span className="text-[10px] text-muted">
                        {running
                          ? 'Running the query…'
                          : `Ctrl+Enter runs against ${pinnedDatabase ?? 'the database'} without submitting; Submit grades it.`}
                      </span>
                    )}
                  </div>
                  {/* Released by the server only after this question was attempted. */}
                  {reference ? (
                    <Card className="p-4">
                      <details>
                        <summary className="cursor-pointer text-[11px] font-semibold text-muted">
                          Reference solution
                        </summary>
                        {reference.brokenSql && question.type !== 'fix-query' ? (
                          <>
                            <div className="mono-label mt-2">Query under review</div>
                            <CodeBlock text={reference.brokenSql} className="mt-1 text-[11px]" />
                          </>
                        ) : null}
                        {reference.referenceSql ? (
                          <CodeBlock text={reference.referenceSql} className="mt-2 text-[11px]" />
                        ) : (
                          <div className="mt-2 text-[11px] text-muted">
                            This challenge has no reference SQL; compare with the feedback above.
                          </div>
                        )}
                        {reference.expectedResult ? (
                          <div className="mt-2 text-[11px] text-muted">
                            Expected: {reference.expectedResult}
                          </div>
                        ) : null}
                        {reference.orderMatters ? (
                          <div className="mt-2">
                            <Badge tone="neutral">row order matters</Badge>
                          </div>
                        ) : null}
                      </details>
                    </Card>
                  ) : null}

                  {evaluation ? (
                    <Card className="p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                        <ScoreRing score={evaluation.scores.overall} size={112} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={verdictTone(evaluation.verdict)}>
                              {evaluation.verdict === 'not-executed'
                                ? 'reviewed'
                                : evaluation.verdict.replace('-', ' ')}
                            </Badge>
                            {evaluation.executed ? (
                              <Badge tone="mint">executed read-only</Badge>
                            ) : (
                              <Badge tone="warn">not executed</Badge>
                            )}
                            {current.duplicate ? <Badge tone="info">duplicate</Badge> : null}
                          </div>
                          <div className="mt-2 text-[12.5px] text-ink-soft">
                            {evaluation.summary}
                          </div>
                          <div className="practice-score-grid mt-3">
                            <div className="stat">
                              <div className="stat-label">Correctness</div>
                              <div className="stat-value">{evaluation.scores.correctness}</div>
                            </div>
                            <div className="stat">
                              <div className="stat-label">Performance</div>
                              <div className="stat-value">{evaluation.scores.performance}</div>
                            </div>
                            <div className="stat">
                              <div className="stat-label">Style</div>
                              <div className="stat-value">{evaluation.scores.style}</div>
                            </div>
                          </div>
                          <details className="score-explainer mt-2">
                            <summary>
                              <Info size={11} /> How this score is calculated
                            </summary>
                            <div className="score-explainer-body">
                              Correctness is 60% of the overall score and comes from comparing your
                              result with the reference (column count, row multiset, and order when
                              required). Performance is 25% from static rules and EXPLAIN. Style is
                              15% from readability rules. A truncated comparison caps correctness at
                              90; non-executed answers use the AI evaluation only.
                            </div>
                          </details>
                        </div>
                      </div>

                      {evaluation.comparison ? (
                        <div className="mt-4">
                          <div className="section-title mb-2">Result comparison</div>
                          <ComparisonView comparison={evaluation.comparison} />
                        </div>
                      ) : null}

                      {evaluation.strengths.length > 0 || evaluation.issues.length > 0 ? (
                        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                          {evaluation.strengths.length > 0 ? (
                            <div className="rounded-xl border border-mint/20 bg-mint/5 p-3">
                              <div className="section-title mb-1 text-mint">What worked</div>
                              {evaluation.strengths.map((item, index) => (
                                <div key={index} className="text-[11.5px] text-ink-soft">
                                  • {item}
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {evaluation.issues.length > 0 ? (
                            <div className="rounded-xl border border-warn/20 bg-warn/5 p-3">
                              <div className="section-title mb-1 text-warn">What to fix</div>
                              {evaluation.issues.map((item, index) => (
                                <div key={index} className="text-[11.5px] text-ink-soft">
                                  • {item}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="callout mt-4 flex items-start gap-2">
                        <Lightbulb size={14} className="mt-0.5 shrink-0 text-ember" />
                        <div>
                          <div className="font-semibold text-ink">Next hint</div>
                          <div className="text-[11.5px] text-muted">{evaluation.nextHint}</div>
                        </div>
                      </div>

                      {evaluation.aiFeedback ? (
                        <div className="mt-4">
                          <div className="section-title mb-2">AI feedback</div>
                          <Markdown>{evaluation.aiFeedback}</Markdown>
                        </div>
                      ) : null}

                      {evaluation.findings.length > 0 ? (
                        <div className="mt-4">
                          <div className="section-title mb-2">Rule findings on your answer</div>
                          <FindingsList
                            findings={evaluation.findings}
                            compact
                            showFilters={false}
                            emptyTitle="No rule findings"
                          />
                        </div>
                      ) : null}

                      {evaluation.explain ? (
                        <details className="mt-4 rounded-xl border border-line-soft bg-panel-2/40 p-3">
                          <summary className="cursor-pointer text-[11px] font-semibold text-muted">
                            EXPLAIN plan for your answer
                          </summary>
                          <div className="mt-2">
                            <ExplainPanel explain={evaluation.explain} analyzing={false} />
                          </div>
                        </details>
                      ) : null}

                      {evaluation.userResult || evaluation.referenceResult ? (
                        <div className="mt-4 flex flex-col gap-2">
                          {evaluation.userResult ? (
                            <details className="rounded-xl border border-line-soft bg-panel-2/40 p-2">
                              <summary className="cursor-pointer px-1 py-1 text-[11px] font-semibold text-muted">
                                Your result
                              </summary>
                              <div className="mt-1 max-h-[320px] overflow-auto rounded-lg border border-line-soft">
                                <ResultsGrid result={evaluation.userResult} />
                              </div>
                            </details>
                          ) : null}
                          {evaluation.referenceResult ? (
                            <details className="rounded-xl border border-line-soft bg-panel-2/40 p-2">
                              <summary className="cursor-pointer px-1 py-1 text-[11px] font-semibold text-muted">
                                Reference result
                              </summary>
                              <div className="mt-1 max-h-[320px] overflow-auto rounded-lg border border-line-soft">
                                <ResultsGrid result={evaluation.referenceResult} />
                              </div>
                            </details>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<ArrowLeft size={12} />}
                          onClick={() => goTo(activeIndex - 1)}
                          disabled={activeIndex === 0}
                        >
                          Previous
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => goTo(activeIndex + 1)}
                          disabled={activeIndex >= practiceSet.questions.length - 1}
                        >
                          Next challenge <ArrowRight size={12} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          onClick={() => {
                            updateCurrent({ evaluation: null, duplicate: false });
                          }}
                        >
                          Try again
                        </Button>
                      </div>
                    </Card>
                  ) : null}
                </div>

                {schemaPanelOpen ? (
                  /*
                   * The panel hugs its content and scrolls the tree inside a
                   * bounded box, so it stays a panel next to the taller first
                   * column instead of stretching down with the results.
                   *
                   * h-0 + min-h-full keeps the wrapper out of the row's height
                   * calculation: without it the panel would decide how tall the
                   * row is, and expanding a table would resize the editor.
                   */
                  <aside className="hidden h-0 min-h-full lg:flex lg:flex-col">
                    <div className="sticky top-4 flex flex-col overflow-hidden rounded-xl border border-line-soft bg-panel">
                      <SchemaSidebar
                        variant="panel"
                        compact
                        treeMaxHeight="min(400px, calc(100vh - 22rem))"
                        className="min-h-0"
                        database={practiceSet?.database ?? pinnedDatabase}
                        profileId={activeProfileId}
                        onInsert={insertFromSchema}
                        onPreviewTable={previewTable}
                      />
                    </div>
                  </aside>
                ) : null}

                {practiceSet && navigatorOpen ? (
                  <aside className="practice-nav self-start" aria-label="Question navigator">
                    <div className="practice-nav-head">
                      <ListChecks size={13} className="text-ember" />
                      <span>Questions</span>
                      <span className="practice-nav-count">
                        {answeredCount}/{practiceSet.questions.length}
                      </span>
                      <IconButton
                        label="Hide question navigator"
                        nativeTitle={false}
                        onClick={() => setNavigatorOpen(false)}
                      >
                        <PanelRightClose size={12} />
                      </IconButton>
                    </div>
                    <div className="practice-nav-grid">
                      {practiceSet.questions.map((item, index) => {
                        const answered = Boolean(answers[item.id]?.evaluation);
                        const itemFlagged = Boolean(flagged[item.id]);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={cn(
                              'practice-nav-box',
                              answered && 'answered',
                              index === activeIndex && 'active',
                              itemFlagged && 'flagged',
                            )}
                            onClick={() => goTo(index)}
                            aria-label={`Question ${index + 1}${answered ? ', answered' : ', unanswered'}${itemFlagged ? ', flagged' : ''}`}
                            title={item.title}
                          >
                            {index + 1}
                            {itemFlagged ? (
                              <Flag size={8} className="practice-nav-flag" fill="currentColor" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                    <div className="practice-nav-legend">
                      <span>
                        <i className="practice-nav-dot answered" /> answered
                      </span>
                      <span>
                        <i className="practice-nav-dot" /> unanswered
                      </span>
                      <span>
                        <Flag size={9} /> flagged
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn('practice-nav-flag-btn', flaggedCurrent && 'text-warn')}
                      icon={<Flag size={11} fill={flaggedCurrent ? 'currentColor' : 'none'} />}
                      onClick={() => {
                        if (question) toggleFlag(question.id);
                      }}
                    >
                      {flaggedCurrent ? 'Flagged for review' : 'Flag this question'}
                    </Button>
                  </aside>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        {schemaDrawerOpen && !isLargeViewport ? (
          <div
            className="fixed inset-0 z-50"
            role="dialog"
            aria-modal="true"
            aria-label="Schema browser"
          >
            <div
              className="absolute inset-0 bg-black/55 backdrop-blur-[1px]"
              onClick={() => setSchemaDrawerOpen(false)}
            />
            <aside className="absolute inset-y-0 right-0 flex w-[min(88vw,360px)] flex-col border-l border-line bg-panel shadow-2xl">
              <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
                <span className="text-[11px] font-semibold text-ink">Schema</span>
                <IconButton
                  label="Close schema browser"
                  className="ml-auto"
                  onClick={() => setSchemaDrawerOpen(false)}
                >
                  <X size={14} />
                </IconButton>
              </div>
              <div className="min-h-0 flex-1">
                <SchemaSidebar
                  variant="panel"
                  className="h-full"
                  database={practiceSet?.database ?? pinnedDatabase}
                  profileId={activeProfileId}
                  onInsert={insertFromSchema}
                  onPreviewTable={previewTable}
                />
              </div>
            </aside>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={clearConfirm}
        onClose={() => setClearConfirm(false)}
        onConfirm={() => void clearAttempts()}
        title="Clear practice attempts?"
        message="This removes the local attempt history and topic mastery for this connection. Saved challenge sets remain."
        confirmLabel="Clear attempts"
        danger
      />
    </div>
  );
}
