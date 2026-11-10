import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { EditorView } from '@codemirror/view';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Flame,
  FlameKindling,
  Flag,
  FlaskConical,
  Info,
  Lightbulb,
  ListChecks,
  PanelRight,
  PanelRightClose,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Target,
  Timer,
  Trash2,
  Trophy,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import type {
  AiChatMessage,
  PracticeAnswer,
  PracticeComparison,
  PracticeDaily,
  PracticeDifficulty,
  PracticeEvaluation,
  PracticeHintLadder,
  PracticeProgressPublic,
  PracticeQuestionPublic,
  PracticeReviewQueueItem,
  PracticeSetPublic,
  PracticeTopic,
  QueryResult,
} from '@shared/types';
import { PRACTICE_DIFFICULTIES, PRACTICE_TOPICS } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { dbApi } from '@/lib/db-api';
import { postSse } from '@/lib/sse';
import { formatDate } from '@/lib/format';
import { selectDatabaseHint } from '@/lib/copy';
import { SqlEditor } from '@/components/SqlEditor';
import { SchemaSidebar } from '@/components/SchemaSidebar';
import { Markdown } from '@/components/Markdown';
import { FindingsList } from '@/components/Findings';
import { ExplainPanel } from '@/components/ExplainPanel';
import { ResultsGrid } from '@/components/ResultsGrid';
import { Tooltip } from '@/components/Tooltip';
import { AiAssistant } from '@/components/AiAssistant';
import { Combobox, MultiSelect, TextCombobox } from '@/components/Combobox';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Modal,
  PageHeader,
  ScoreRing,
  Skeleton,
  Spinner,
  StatCard,
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

/**
 * A stable empty transcript. The coach is given this when a challenge has no
 * thread yet; a fresh array on every render would look like a changed
 * transcript to the chat transport.
 */
const NO_COACH_TURNS: AiChatMessage[] = [];

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

/** Drafts belong to the account, not the browser: the key carries the user id. */
function draftKey(userId: string, profileId: string, setId: string): string {
  return `${DRAFT_PREFIX}.${userId}.${profileId}.${setId}`;
}

function readDraft(
  userId: string | undefined,
  profileId: string,
  setId: string,
): Record<string, PracticeDraft> {
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(draftKey(userId, profileId, setId));
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

function writeDraft(
  userId: string | undefined,
  profileId: string,
  setId: string,
  drafts: Record<string, PracticeDraft>,
): void {
  if (!userId) return;
  try {
    const key = draftKey(userId, profileId, setId);
    if (Object.keys(drafts).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(drafts));
  } catch {
    // Storage can be unavailable (private mode, quota); drafts are best-effort.
  }
}

/** Stable composite key for a review card (both halves are server ids). */
function reviewItemKey(item: Pick<PracticeReviewQueueItem, 'setId' | 'questionId'>): string {
  return `${item.setId}:${item.questionId}`;
}

/** How long the verdict badge keeps its pulse class: the animation is 0.45s. */
const VERDICT_PULSE_MS = 500;

/**
 * Question-content swaps ride the View Transitions API when the browser has
 * it: the state update is flushed synchronously inside the transition
 * callback (the React 19 pattern), so the DOM changes where the browser takes
 * its snapshots and the old question crossfades into the new one at the fast
 * duration. The content is different on both sides, so no element is named as
 * a shared transition element — the root crossfade is all there is. Without
 * the API the swap stays instant.
 */
function withQuestionTransition(update: () => void): void {
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(() => {
      flushSync(update);
    });
    return;
  }
  update();
}

/** The wall-clock a question has been open, as `mm:ss`. Display only. */
// eslint-disable-next-line react-refresh/only-export-components -- imported by the practice UI tests; a shared lib file is outside this change
export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/**
 * True when a keyboard event starts in a surface where plain keys compose
 * text: form fields, contenteditable nodes, or a CodeMirror editor (which
 * hosts the caret in a contenteditable div inside `.cm-editor`). Navigation
 * shortcuts must yield to those.
 */
// eslint-disable-next-line react-refresh/only-export-components -- imported by the practice UI tests; a shared lib file is outside this change
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const node = target as TypingTargetLike;
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (node.isContentEditable === true) return true;
  return typeof node.closest === 'function' ? Boolean(node.closest('.cm-editor')) : false;
}

function CodeBlock({ text, className }: { text: string; className?: string }) {
  return <pre className={cn('code-block', className)}>{text}</pre>;
}

/** The saved challenge sets, so a previous one can be picked up again. */
function RecentSetsCard({
  sets,
  onPick,
  loading = false,
}: {
  sets: PracticeSetPublic[];
  onPick: (item: PracticeSetPublic) => void;
  /** True while the hub fetch is in flight; two row-height skeletons. */
  loading?: boolean;
}) {
  if (loading) {
    return (
      <Card className="p-3">
        <div className="section-title mb-2">Recent challenge sets</div>
        <div className="flex flex-col gap-2">
          <Skeleton height={52} />
          <Skeleton height={52} />
        </div>
      </Card>
    );
  }
  if (sets.length === 0) return null;
  return (
    <Card className="p-3">
      <div className="section-title mb-2">Recent challenge sets</div>
      <div className="flex flex-col gap-2">
        {sets.map((item) => (
          <button
            key={item.id}
            type="button"
            className="recent-set-row flex items-center gap-2 border border-line-soft bg-panel-2 px-3 py-2 text-left hover:border-ember/35"
            onClick={() => onPick(item)}
          >
            <FlaskConical size={13} className="text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-2xs text-ink-soft">
                {item.database} · {item.questions.length} challenges
              </span>
              <span className="block text-2xs text-muted">{formatDate(item.createdAt)}</span>
            </span>
            <span className="font-mono text-micro text-muted">{item.model}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function topicLabel(topic: PracticeTopic): string {
  return PRACTICE_TOPICS.find((item) => item.id === topic)?.label ?? topic;
}

/**
 * The question tracker: one square per question, compact enough to sit
 * above the schema tables panel. Flagging lives in the head row so the
 * strip stays a heading plus a grid and nothing else.
 */
function QuestionTracker({
  set,
  answers,
  flagged,
  activeIndex,
  answeredCount,
  flaggedCurrent,
  canFlag,
  onGoTo,
  onToggleFlag,
  onHide,
}: {
  set: PracticeSetPublic;
  answers: Record<string, AnswerState>;
  flagged: Record<string, boolean>;
  activeIndex: number;
  answeredCount: number;
  flaggedCurrent: boolean;
  canFlag: boolean;
  onGoTo: (index: number) => void;
  onToggleFlag: () => void;
  onHide: () => void;
}) {
  return (
    <>
      <div className="practice-nav-head">
        <ListChecks size={12} className="text-ember" />
        <span>Questions</span>
        <span className="practice-nav-count">
          {answeredCount}/{set.questions.length}
        </span>
        <IconButton
          label={flaggedCurrent ? 'Unflag this question' : 'Flag this question'}
          disabled={!canFlag}
          className={cn(flaggedCurrent ? 'text-warn' : undefined)}
          onClick={onToggleFlag}
        >
          <Flag size={11} fill={flaggedCurrent ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton label="Hide question navigator" tooltip={false} onClick={onHide}>
          <PanelRightClose size={11} />
        </IconButton>
      </div>
      <div className="practice-nav-grid">
        {set.questions.map((item, index) => {
          const answered = Boolean(answers[item.id]?.evaluation);
          const itemFlagged = Boolean(flagged[item.id]);
          return (
            <Tooltip key={item.id} label={item.title} side="top">
              <button
                type="button"
                className={cn(
                  'practice-nav-box',
                  answered && 'answered',
                  index === activeIndex && 'active',
                  itemFlagged && 'flagged',
                )}
                onClick={() => onGoTo(index)}
                aria-label={`Question ${index + 1}${answered ? ', answered' : ', unanswered'}${itemFlagged ? ', flagged' : ''}`}
              >
                {index + 1}
                {itemFlagged ? (
                  <Flag size={8} className="practice-nav-flag" fill="currentColor" />
                ) : null}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </>
  );
}

function verdictTone(
  verdict: PracticeEvaluation['verdict'],
): 'mint' | 'warn' | 'danger' | 'neutral' {
  if (verdict === 'correct') return 'mint';
  if (verdict === 'close') return 'warn';
  if (verdict === 'incorrect') return 'danger';
  return 'neutral';
}

/** The per-topic score bars; the hub dashboard card and the setup panel share them. */
function ProgressTopicBars({ progress }: { progress: PracticeProgressPublic }) {
  return (
    <div className="flex flex-col gap-2">
      {progress.topics
        .filter((topic) => topic.attempts > 0)
        .sort((a, b) => b.attempts - a.attempts)
        .slice(0, 8)
        .map((topic) => (
          <div key={topic.topic}>
            <div className="flex items-center justify-between gap-2 text-2xs">
              <span className="truncate text-ink-soft">{topicLabel(topic.topic)}</span>
              <span className="font-mono text-muted">
                {topic.averageScore} · {topic.attempts}×
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-3">
              <div
                className={cn(
                  'topic-bar-fill h-full rounded-full',
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
  );
}

/**
 * The learning dashboard: streaks, XP, per-topic scores and the recommended
 * next topics. The practice hub hosts it as a first-class card; the setup
 * panel reuses the same component so the two never drift apart.
 */
export function PracticeProgressCard({
  progress,
  onRefresh,
  onClear,
  loading = false,
}: {
  progress: PracticeProgressPublic | null;
  onRefresh: () => void;
  onClear: () => void;
  /** True while the hub fetch is in flight; three .stat-sized skeletons. */
  loading?: boolean;
}) {
  const currentStreak = progress?.currentStreak ?? 0;
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <Trophy size={14} className="text-ember" />
        <div className="section-title">Progress</div>
        <Button
          variant="tertiary"
          size="sm"
          className="ml-auto"
          icon={<RefreshCw size={12} />}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>
      {loading ? (
        <div className="grid grid-cols-3 gap-2">
          <Skeleton height={64} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </div>
      ) : progress && progress.totalAttempts > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="font-mono text-2xs text-muted">
            {progress.totalAttempts} attempts · avg {progress.averageScore}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <StatCard
              label="Current streak"
              value={
                <span key={currentStreak} className="stat-value num-pop">
                  {currentStreak}
                </span>
              }
              icon={currentStreak > 0 ? <Flame size={14} /> : <FlameKindling size={14} />}
              tone={currentStreak > 0 ? 'ember' : undefined}
            />
            <StatCard
              label="Longest streak"
              value={
                <span key={progress.longestStreak ?? 0} className="stat-value num-pop">
                  {progress.longestStreak ?? 0}
                </span>
              }
              icon={<CalendarDays size={14} />}
            />
            <StatCard
              label="XP"
              value={
                <span key={progress.xp ?? 0} className="stat-value num-pop">
                  {progress.xp ?? 0}
                </span>
              }
              icon={<Zap size={14} />}
              tone="mint"
            />
          </div>
          {progress.recommendedTopics.length > 0 ? (
            <div>
              <div className="mono-label mb-1">Recommended next</div>
              <div className="text-2xs text-ink-soft">
                {progress.recommendedTopics.map((topic) => topicLabel(topic)).join(' · ')}
              </div>
            </div>
          ) : null}
          <ProgressTopicBars progress={progress} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="tertiary"
              size="sm"
              className="text-danger"
              icon={<Trash2 size={11} />}
              onClick={onClear}
            >
              Clear attempts
            </Button>
            {progress.recent.length > 0 ? (
              <span className="text-2xs text-muted">
                last {formatDate(progress.recent[0].createdAt)}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="text-2xs text-muted">Attempt stats appear after you submit answers.</div>
      )}
    </Card>
  );
}

/**
 * Friendly copy for the days a daily challenge cannot exist. `no-provider`
 * and `generation-failed` come from the server; anything else means no
 * candidate was available either.
 */
function dailyReasonLine(reason: string | undefined): string {
  if (reason === 'no-provider') {
    return 'No AI provider is configured yet — add one in Settings to get a daily challenge.';
  }
  if (reason === 'generation-failed') {
    return "Today's challenge could not be generated. Give it another try.";
  }
  return 'No daily challenge today — generate a set to keep the streak going.';
}

/** Today's one-question challenge, picked or generated once per day by the server. */
export function PracticeDailyCard({
  daily,
  loading,
  failed,
  onOpen,
  onRetry,
}: {
  daily: PracticeDaily | null;
  loading: boolean;
  failed: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const challenge = daily?.set?.questions[0] ?? null;
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <CalendarDays size={14} className="text-ember" />
        <div className="section-title">Daily challenge</div>
        {daily?.date ? (
          <span className="ml-auto font-mono text-2xs text-muted">{daily.date}</span>
        ) : null}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-2xs text-muted">
          <Spinner size={12} />
          <span>Preparing today's challenge…</span>
        </div>
      ) : !daily ? (
        failed ? (
          <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
            <span className="flex-1">Today's challenge could not be loaded.</span>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : null
      ) : daily.set && challenge ? (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-bold tracking-tight">{challenge.title}</div>
          <div className="line-clamp-2 text-2xs leading-5 text-muted">{challenge.scenario}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="ember">{challenge.difficulty}</Badge>
          </div>
          <div>
            <Button variant="primary" size="sm" icon={<FlaskConical size={12} />} onClick={onOpen}>
              Open challenge
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
          <span className="flex-1">{dailyReasonLine(daily.reason)}</span>
          {daily.reason === 'generation-failed' ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** The due spaced-repetition cards with their per-item actions. */
export function ReviewQueueCard({
  items,
  busyKey,
  onStart,
  onDismiss,
  loading = false,
}: {
  items: PracticeReviewQueueItem[];
  busyKey: string | null;
  onStart: (item: PracticeReviewQueueItem) => void;
  onDismiss: (item: PracticeReviewQueueItem) => void;
  /** True while the hub fetch is in flight; two row-height skeletons. */
  loading?: boolean;
}) {
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <RotateCcw size={14} className="text-ember" />
        <div className="section-title num">Review due today ({items.length})</div>
      </div>
      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      ) : items.length === 0 ? (
        <div className="text-2xs text-muted">
          Nothing to review right now — graded challenges come back here when they are due.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => {
            const key = reviewItemKey(item);
            const busy = busyKey === key;
            return (
              <div
                key={key}
                className="review-row flex items-start gap-2 border border-line-soft bg-panel-2 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-2xs font-semibold text-ink-soft">{item.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {item.topics.length > 0 ? (
                      <span className="text-2xs text-muted">
                        {item.topics.map((topic) => topicLabel(topic)).join(' · ')}
                      </span>
                    ) : null}
                    <Badge tone="ember">{item.difficulty}</Badge>
                    <Badge tone={item.box === 0 ? 'warn' : 'info'}>Box {item.box + 1}</Badge>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => onStart(item)}>
                    Start review
                  </Button>
                  <IconButton
                    label="Dismiss this review item"
                    disabled={busy}
                    onClick={() => onDismiss(item)}
                  >
                    <X size={12} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ComparisonView({ comparison }: { comparison: PracticeComparison }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={comparison.matched ? 'mint' : 'warn'}>
          {comparison.matched ? 'results match' : 'results differ'}
        </Badge>
        <span className="text-2xs text-muted">
          {comparison.ordered ? 'row order matters' : 'row order ignored'}
        </span>
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
      <div className="text-2xs text-muted">{comparison.reason}</div>
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

/** One ladder tier in reveal order; tiers the model omitted are skipped. */
export interface HintTier {
  label: string;
  text: string;
  /** The skeleton tier may carry partial SQL, so it renders as code. */
  code?: boolean;
}

/** The ladder as an ordered, display-ready list of tiers. */
// eslint-disable-next-line react-refresh/only-export-components -- imported by the practice UI tests; a shared lib file is outside this change
export function hintLadderTiers(ladder: PracticeHintLadder): HintTier[] {
  const tiers: HintTier[] = [];
  if (ladder.nudge) tiers.push({ label: 'Nudge', text: ladder.nudge });
  if (ladder.approach) tiers.push({ label: 'Approach', text: ladder.approach });
  if (ladder.skeleton) tiers.push({ label: 'Skeleton', text: ladder.skeleton, code: true });
  return tiers;
}

/**
 * The hint box of the active question. Questions generated with the tiered
 * ladder reveal one tier per click, strictly in order (nudge, then approach,
 * then skeleton); older questions fall back to the flat hint list.
 */
export function QuestionHints({
  question,
  shown,
  onReveal,
}: {
  question: PracticeQuestionPublic;
  shown: number;
  onReveal: () => void;
}) {
  const ladder = question.hintLadder ? hintLadderTiers(question.hintLadder) : [];
  if (ladder.length > 0) {
    const next = ladder[shown];
    return (
      <div className="mt-2 rounded-lg border border-warn/20 bg-warn/5 px-3 py-2">
        <div className="flex items-center gap-2">
          <Lightbulb size={11} className="text-warn" />
          <span className="text-2xs font-semibold tracking-wide text-warn uppercase">Hints</span>
          <span className="font-mono text-2xs text-muted">
            {Math.min(shown, ladder.length)}/{ladder.length}
          </span>
          <Button
            variant="tertiary"
            size="sm"
            className="ml-auto h-7 px-3 text-2xs"
            tooltip="Reveal the next tier (Alt+H)"
            onClick={onReveal}
            disabled={shown >= ladder.length}
          >
            {next ? `Show the ${next.label.toLowerCase()}` : 'All tiers revealed'}
          </Button>
        </div>
        {ladder.slice(0, shown).map((tier) => (
          <div key={tier.label} className="mt-1 text-2xs leading-5 text-ink-soft">
            <span className="font-semibold text-warn">{tier.label}:</span>
            {tier.code ? (
              <CodeBlock text={tier.text} className="mt-1 text-2xs" />
            ) : (
              <span> {tier.text}</span>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (question.hints.length === 0) return null;
  return (
    <div className="mt-2 rounded-lg border border-warn/20 bg-warn/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <Lightbulb size={11} className="text-warn" />
        <span className="text-2xs font-semibold tracking-wide text-warn uppercase">Hints</span>
        <Button
          variant="tertiary"
          size="sm"
          className="ml-auto h-7 px-3 text-2xs"
          tooltip="Reveal a hint (Alt+H)"
          onClick={onReveal}
          disabled={shown >= question.hints.length}
        >
          {shown === 0 ? 'Show a hint' : 'Another hint'}
        </Button>
      </div>
      {question.hints.slice(0, shown).map((hint, index) => (
        <div key={index} className="mt-1 text-2xs leading-5 text-ink-soft">
          {index + 1}. {hint}
        </div>
      ))}
    </div>
  );
}

/** The error banner of the SQL Lab page. */
function PracticeErrorNote({ message }: { message: string }) {
  return (
    <div className="callout danger flex items-start gap-2">
      <XCircle size={15} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/**
 * The SQL Lab page while no challenge set is open.
 *
 * The empty state is a direct child of the page, so it settles in the space
 * that is left under the page header instead of sitting at the top of the
 * viewport with a blank page below it. The action it offers is the only
 * "generate challenges" button on this screen. The learning loop — progress,
 * the daily challenge and the due review queue — lives here on the hub as a
 * row of first-class cards.
 */
export function PracticeEmptyScreen({
  database,
  error,
  recentSets,
  onPick,
  onGenerate,
  progress,
  onRefreshProgress,
  onClearAttempts,
  daily,
  dailyLoading,
  dailyFailed,
  onOpenDaily,
  onRetryDaily,
  reviewItems,
  reviewBusyKey,
  onStartReview,
  onDismissReview,
  hubLoading,
}: {
  database: string;
  error: string | null;
  recentSets: PracticeSetPublic[];
  onPick: (item: PracticeSetPublic) => void;
  onGenerate: () => void;
  progress: PracticeProgressPublic | null;
  onRefreshProgress: () => void;
  onClearAttempts: () => void;
  daily: PracticeDaily | null;
  dailyLoading: boolean;
  dailyFailed: boolean;
  onOpenDaily: () => void;
  onRetryDaily: () => void;
  reviewItems: PracticeReviewQueueItem[];
  reviewBusyKey: string | null;
  onStartReview: (item: PracticeReviewQueueItem) => void;
  onDismissReview: (item: PracticeReviewQueueItem) => void;
  /** True until the first progress/review/sets fetch of this profile resolves. */
  hubLoading: boolean;
}) {
  return (
    <>
      <PageHeader
        title="SQL Lab"
        subtitle="Generate challenges, answer them, and compare with a reference solution."
        actions={<span className="font-mono text-2xs text-muted">{database}</span>}
      />
      {error ? <PracticeErrorNote message={error} /> : null}
      <div className="empty-anchor">
        <EmptyState
          icon={<Target size={20} />}
          title="No challenge set yet"
          copy="Open the setup panel to choose tables, topics, and difficulty, then generate a set."
          action={
            <Button variant="primary" icon={<Sparkles size={13} />} onClick={onGenerate}>
              Generate challenges
            </Button>
          }
        />
        <div className="mt-3 grid w-full max-w-4xl grid-cols-1 gap-3 lg:grid-cols-2">
          <PracticeProgressCard
            progress={progress}
            onRefresh={onRefreshProgress}
            onClear={onClearAttempts}
            loading={hubLoading}
          />
          <div className="flex flex-col gap-3">
            <PracticeDailyCard
              daily={daily}
              loading={dailyLoading}
              failed={dailyFailed}
              onOpen={onOpenDaily}
              onRetry={onRetryDaily}
            />
            <ReviewQueueCard
              items={reviewItems}
              busyKey={reviewBusyKey}
              onStart={onStartReview}
              onDismiss={onDismissReview}
              loading={hubLoading}
            />
          </div>
        </div>
        <div className="mt-3 w-full max-w-4xl">
          <RecentSetsCard sets={recentSets} onPick={onPick} loading={hubLoading} />
        </div>
      </div>
    </>
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
  // The learning loop: due review cards and today's daily challenge. The daily
  // fetch can take seconds (it may generate the challenge), so the result is
  // cached per profile for the rest of the session.
  const [reviewItems, setReviewItems] = useState<PracticeReviewQueueItem[]>([]);
  const [reviewBusyKey, setReviewBusyKey] = useState<string | null>(null);
  // True until the first progress/review/sets fetch of the active profile has
  // resolved (successfully or not); the hub cards show skeletons while it is.
  const [hubLoading, setHubLoading] = useState(true);
  // A profile switch resets the hub to skeletons. Adjusting during render (the
  // pattern ResultsGridBase uses) keeps the reset off the effect body.
  const [loadedProfileId, setLoadedProfileId] = useState<string | null>(activeProfileId);
  if (activeProfileId !== loadedProfileId) {
    setLoadedProfileId(activeProfileId);
    setHubLoading(true);
  }
  const [daily, setDaily] = useState<PracticeDaily | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState(false);
  const dailyCache = useRef<Map<string, PracticeDaily>>(new Map());
  // The profile the in-flight daily request belongs to; a late response for a
  // profile that was switched away must never be applied.
  const dailyRequestProfileId = useRef<string | null>(null);
  // Per-question attempt totals backing the "Attempt N" label; seeded from the
  // recorded attempts and bumped locally after each newly graded submission.
  const [attemptCounts, setAttemptCounts] = useState<Record<string, number>>({});
  const [clearConfirm, setClearConfirm] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(true);
  const [flagged, setFlagged] = useState<Record<string, boolean>>({});
  // The stopwatch of the open question. `questionOpenedAt` resets whenever the
  // active question changes (the same commit that clears hints); the tick only
  // drives a mm:ss display — nothing is enforced or recorded.
  const [questionOpenedAt, setQuestionOpenedAt] = useState<number>(() => Date.now());
  const [elapsedTick, setElapsedTick] = useState<number>(() => Date.now());
  // The coach keeps a thread per challenge, so moving to another challenge
  // and back does not lose the conversation.
  const [coachTurns, setCoachTurns] = useState<Record<string, AiChatMessage[]>>({});
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
  // Session metadata of the open question: a display-only stopwatch and the
  // attempt counter ("recorded attempts + 1").
  const elapsedMs = Math.max(0, elapsedTick - questionOpenedAt);
  const attemptNumber = question ? (attemptCounts[question.id] ?? 0) + 1 : 1;
  // How many tiers the current question can still reveal: the ladder when one
  // exists, otherwise the flat hint list.
  const hintTierCount = question
    ? question.hintLadder
      ? hintLadderTiers(question.hintLadder).length
      : question.hints.length
    : 0;
  // The keyboard flow steps aside while a dialog owns the screen.
  const dialogOpen = setupOpen || clearConfirm;

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

  // The challenge view is two columns at lg and up: the challenge itself
  // (brief, editor, result) and a pinned right stack — the question tracker
  // above the database tables. Below lg the schema panel becomes a drawer
  // and the challenge column takes the full width.
  const stageColumns = cn(
    'grid grid-cols-1 gap-4',
    schemaPanelOpen && 'lg:grid-cols-[minmax(0,1fr)_280px]',
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

  /**
   * Load today's daily challenge for a profile. Each profile is fetched once
   * per session and cached, so switching back and forth does not re-run the
   * (possibly slow) generation; `force` bypasses the cache for retries.
   */
  const loadDaily = useCallback((profileId: string, options: { force?: boolean } = {}): void => {
    if (!options.force) {
      const cached = dailyCache.current.get(profileId);
      if (cached) {
        dailyRequestProfileId.current = null;
        setDaily(cached);
        setDailyLoading(false);
        setDailyError(false);
        return;
      }
    } else {
      dailyCache.current.delete(profileId);
    }
    dailyRequestProfileId.current = profileId;
    setDaily(null);
    setDailyLoading(true);
    setDailyError(false);
    void dbApi
      .practiceDaily(profileId)
      .then((entry) => {
        if (dailyRequestProfileId.current !== profileId) return;
        dailyRequestProfileId.current = null;
        dailyCache.current.set(profileId, entry);
        setDaily(entry);
        setDailyLoading(false);
      })
      .catch(() => {
        if (dailyRequestProfileId.current !== profileId) return;
        dailyRequestProfileId.current = null;
        setDailyError(true);
        setDailyLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!activeProfileId) return;
    // The hub loads in one pass: progress, recent sets and the review queue
    // settle together, so the cards show skeletons until all three resolve.
    // Failures resolve too — an empty card beats a skeleton that never ends.
    let cancelled = false;
    void Promise.all([
      dbApi.practiceProgress(activeProfileId).catch(() => undefined),
      dbApi.practiceSets(activeProfileId, 5).catch(() => undefined),
      dbApi.practiceReviewQueue(activeProfileId).catch(() => undefined),
    ]).then(([nextProgress, nextSets, nextReview]) => {
      if (cancelled) return;
      setProgress(nextProgress ?? null);
      setRecentSets(nextSets ?? []);
      setReviewItems(nextReview ?? []);
      setHubLoading(false);
    });
    loadDaily(activeProfileId);
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, loadDaily]);

  // A new question starts without hints and without the previous run result.
  // The state is adjusted while rendering so the panel never shows results
  // that belong to another question. The stopwatch restarts in the handlers
  // that move the active question (activateSet, goTo, startReview).
  const [hintedQuestionId, setHintedQuestionId] = useState(question?.id);
  // The verdict badge pulses once when a fresh evaluation lands `correct`: a
  // mint ring blooms from the pill. Adjusting the flag in the same render-time
  // reset as the run result means a grade restored for a different question
  // (attempts reload, navigation) never replays it.
  const [verdictPulse, setVerdictPulse] = useState(false);
  if (hintedQuestionId !== question?.id) {
    setHintedQuestionId(question?.id);
    setHintsShown(0);
    setRunResult(null);
    setRunError(null);
    setVerdictPulse(false);
  }

  // Drop the pulse class a beat after the animation ends (0.45s), so the next
  // correct submission can replay it.
  useEffect(() => {
    if (!verdictPulse) return;
    const timer = window.setTimeout(() => setVerdictPulse(false), VERDICT_PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [verdictPulse]);

  // The stopwatch ticks once a second while a challenge is open; on the hub
  // there is nothing to time, so no interval runs at all.
  useEffect(() => {
    if (!practiceSet || !question) return;
    const timer = window.setInterval(() => setElapsedTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [practiceSet, question]);

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
    const stored = readDraft(
      useAppStore.getState().currentUser?.id,
      activeProfileId,
      practiceSet.id,
    );
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
    writeDraft(useAppStore.getState().currentUser?.id, activeProfileId, practiceSet.id, drafts);
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
      // The per-question totals seed the "Attempt N" label; the label counts
      // recorded attempts, so it is derived straight from this list.
      const counts: Record<string, number> = {};
      for (const attempt of attempts) {
        counts[attempt.questionId] = (counts[attempt.questionId] ?? 0) + 1;
      }
      setAttemptCounts(counts);
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
    setAttemptCounts({});
    setFlagged({});
    // A freshly opened set starts its first question's stopwatch at zero.
    setQuestionOpenedAt(Date.now());
    setElapsedTick(Date.now());
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
      // Graded answers and attempts are stored per set, so picking a set from
      // the hub — even weeks later — brings its history straight back.
      void loadAnswers(next.id);
      void loadAttempts(next.id);
    }
  };

  // SQL Lab always lands on the hub. Sets are never auto-opened — not on
  // navigation and not on a reload — so the page stays the place where a set
  // is chosen or generated; resuming is one click on a recent set.

  const loadProgress = async (): Promise<void> => {
    if (!activeProfileId) return;
    try {
      setProgress(await dbApi.practiceProgress(activeProfileId));
      setRecentSets(await dbApi.practiceSets(activeProfileId, 5));
      // The review queue changes on every graded submission (the evaluation
      // reschedules the card), so it rides along with the progress refresh.
      setReviewItems(await dbApi.practiceReviewQueue(activeProfileId));
    } catch {
      // Supplementary UI.
    }
  };

  /** Open today's daily challenge straight from the hub card. */
  const openDailyChallenge = (): void => {
    // The daily payload carries the full set, so activation is the same path
    // as picking a recent set; it lands on the challenge and loads its
    // history. The hub → challenge swap is question-content navigation, so it
    // crossfades through the same view transition as `goTo`.
    if (daily?.set) withQuestionTransition(() => activateSet(daily.set));
  };

  /**
   * Open a due review item's set and jump to that question. The queue carries
   * ids only, so the set is resolved through the sets listing — the same
   * mechanism the recent-sets card uses — and the question index is selected
   * after activation.
   */
  const startReview = async (item: PracticeReviewQueueItem): Promise<void> => {
    if (!activeProfileId) return;
    setReviewBusyKey(reviewItemKey(item));
    try {
      const sets = await dbApi.practiceSets(activeProfileId, 50);
      const set = sets.find((entry) => entry.id === item.setId);
      if (!set) {
        toast('The challenge set behind this review item is no longer available.', 'warn');
        return;
      }
      // Starting a review lands on a specific question of the set, so the
      // whole activation rides the same view transition as question
      // navigation — activation and the index jump belong to one swap.
      withQuestionTransition(() => {
        activateSet(set);
        const index = set.questions.findIndex((entry) => entry.id === item.questionId);
        if (index > 0) {
          // Jump past the first question; the stopwatch follows the new one.
          setActiveIndex(index);
          setQuestionOpenedAt(Date.now());
          setElapsedTick(Date.now());
        }
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setReviewBusyKey(null);
    }
  };

  /** Remove one card from the review queue; the recorded attempt stays. */
  const dismissReviewItem = async (item: PracticeReviewQueueItem): Promise<void> => {
    if (!activeProfileId) return;
    setReviewBusyKey(reviewItemKey(item));
    try {
      await dbApi.dismissPracticeReviewItem(item.setId, item.questionId, activeProfileId);
      setReviewItems((previous) =>
        previous.filter(
          (entry) => entry.setId !== item.setId || entry.questionId !== item.questionId,
        ),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setReviewBusyKey(null);
    }
  };

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
      // A correct verdict blooms the mint ring on the verdict badge — the
      // evaluation card is the feedback surface, the pulse is the highlight.
      if (result.verdict === 'correct') setVerdictPulse(true);
      // A new attempt was recorded, so the question's "Attempt N" label moves.
      setAttemptCounts((previous) => ({
        ...previous,
        [question.id]: (previous[question.id] ?? 0) + 1,
      }));
      void loadProgress();
      void loadAnswers(practiceSet.id);
      // No verdict toast: the evaluation card is the single feedback surface,
      // and it is on screen the moment this resolves.
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
    const next = Math.max(0, Math.min(practiceSet.questions.length - 1, index));
    if (next === activeIndex) return;
    // The tracker, the prev/next arrows and the j/k shortcuts all land here,
    // so every question swap crossfades through the same view transition.
    withQuestionTransition(() => {
      setActiveIndex(next);
      // Every jump to another question restarts its stopwatch.
      setQuestionOpenedAt(Date.now());
      setElapsedTick(Date.now());
    });
  };

  // The shortcut listener reads its actions through a ref: `evaluate` and
  // `goTo` close over the live draft and are rebuilt on every render, while
  // the listener itself does not need to re-register on each keystroke.
  const shortcutActions = useRef({ evaluate, goTo });
  useEffect(() => {
    shortcutActions.current = { evaluate, goTo };
  });

  // Learning-loop shortcuts. Plain `j`/`k`/arrow keys never steal typing: they
  // are dropped when the event starts in a field, a contenteditable node or a
  // CodeMirror editor. The Alt chords do not compose text, so they stay live
  // inside the editor (the same rule the workspace uses for Alt+T); they match
  // on `event.code` because macOS folds Option+S/H into other characters.
  // Ctrl+B (schema panel) and Ctrl+Enter (preview run) keep their bindings.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (dialogOpen) return;
      if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        if (isTypingTarget(event.target)) return;
        const next = event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown';
        const prev = event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp';
        if ((!next && !prev) || !question) return;
        event.preventDefault();
        shortcutActions.current.goTo(next ? activeIndex + 1 : activeIndex - 1);
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.code === 'KeyS') {
          if (!question || submitting) return;
          event.preventDefault();
          void shortcutActions.current.evaluate();
        } else if (event.code === 'KeyH') {
          if (!question || hintTierCount === 0) return;
          event.preventDefault();
          setHintsShown((value) => Math.min(hintTierCount, value + 1));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIndex, dialogOpen, hintTierCount, question, submitting]);

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
        <PageHeader title="SQL Lab" subtitle="Challenges generated from your schema." />
        <EmptyState
          icon={<FlaskConical size={20} />}
          title="Select a database first"
          copy={selectDatabaseHint}
        />
      </div>
    );
  }

  return (
    <div className={cn('page', !practiceSet && 'page-centered')}>
      {practiceSet ? (
        <>
          <div className="practice-toolbar">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <FlaskConical size={17} className="shrink-0 text-ember" />
              <span className="practice-toolbar-title">SQL Lab</span>
              <span className="truncate font-mono text-2xs text-muted">
                {practiceSet.database} · {answeredCount}/{practiceSet.questions.length} answered
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="tertiary"
                size="sm"
                icon={<ListChecks size={12} />}
                onClick={() => setNavigatorOpen((value) => !value)}
              >
                {navigatorOpen ? 'Hide challenges' : 'Challenges'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Sparkles size={12} />}
                onClick={openSetup}
              >
                Generate challenges
              </Button>
            </div>
          </div>
          {/* The setup modal shows the same error as a callout; the page-level
              note steps aside while the modal owns the screen. */}
          {error && !setupOpen ? <PracticeErrorNote message={error} /> : null}
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
        </>
      ) : (
        <PracticeEmptyScreen
          database={selectedDatabase}
          /* The setup modal repeats the error as a callout; the page-level
             note steps aside while the modal owns the screen. */
          error={setupOpen ? null : error}
          recentSets={recentSets}
          onPick={(item) => activateSet(item)}
          onGenerate={openSetup}
          progress={progress}
          onRefreshProgress={() => void loadProgress()}
          onClearAttempts={() => setClearConfirm(true)}
          daily={daily}
          dailyLoading={dailyLoading}
          dailyFailed={dailyError}
          onOpenDaily={openDailyChallenge}
          onRetryDaily={() => {
            if (activeProfileId) loadDaily(activeProfileId, { force: true });
          }}
          reviewItems={reviewItems}
          reviewBusyKey={reviewBusyKey}
          onStartReview={(item) => void startReview(item)}
          onDismissReview={(item) => void dismissReviewItem(item)}
          hubLoading={hubLoading}
        />
      )}

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
              <div className="mb-2 flex items-center gap-2">
                <FlaskConical size={15} className="text-ember" />
                <div className="section-title">Generate a challenge set</div>
              </div>
              {providers.length === 0 ? (
                <div className="callout info mb-3 flex flex-wrap items-center gap-2">
                  <Sparkles size={14} />
                  <span className="flex-1">Add a provider to generate challenges.</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigate('/settings?tab=ai')}
                  >
                    Add provider
                  </Button>
                </div>
              ) : null}

              <div className="flex flex-col gap-3">
                <Field
                  label="Tables"
                  hint={
                    tableOptions.length === 0
                      ? 'Schema is loading. Open the Database page if this persists.'
                      : 'Leave empty to auto-select.'
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
                    <TextCombobox
                      value={model}
                      onChange={setModel}
                      inputClassName="font-mono text-2xs"
                      emptyText="No matching models on file."
                      ariaLabel="Model"
                      options={(
                        providers.find((provider) => provider.id === providerId)?.models ?? []
                      ).map((item) => ({ value: item, label: item }))}
                    />
                  </Field>
                </div>

                <Checkbox
                  label="Include masked sample rows"
                  checked={includeSampleData}
                  onChange={setIncludeSampleData}
                />
                <Checkbox
                  label="Add AI feedback after grading"
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
                    <Button variant="tertiary" size="sm" onClick={cancelGeneration}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
                <div className="text-2xs leading-5 text-muted">Queries run read-only.</div>
                {error ? (
                  <div className="callout danger flex items-start gap-2 text-2xs">
                    <XCircle size={13} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                ) : null}
                {generating ? (
                  <div className="rounded-xl border border-line-soft bg-panel-2 p-3">
                    <div className="flex items-center gap-2 text-2xs text-muted">
                      <Spinner size={13} />
                      Generating challenges from {selectedDatabase}…
                      <Button
                        variant="tertiary"
                        size="sm"
                        className="ml-auto"
                        onClick={cancelGeneration}
                      >
                        Stop
                      </Button>
                    </div>
                    {generationText ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-2xs text-muted">Raw stream</summary>
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
              {/*
               * The hub dashboard card is the primary home for progress; the
               * setup panel reuses the same component so the two never drift.
               */}
              <PracticeProgressCard
                progress={progress}
                onRefresh={() => void loadProgress()}
                onClear={() => setClearConfirm(true)}
                loading={hubLoading}
              />

              <RecentSetsCard
                sets={recentSets}
                onPick={(item) => {
                  activateSet(item);
                  setSetupOpen(false);
                }}
                loading={hubLoading}
              />
            </div>
          </div>
        </Modal>

        <div className="practice-main">
          {practiceSet && question ? (
            <>
              {/*
               * The challenge workspace is two columns: the challenge itself
               * (brief, editor, result) and a right stack — the question
               * tracker on top, the database tables under it.
               */}
              <div className={stageColumns}>
                <div className="flex min-w-0 flex-col gap-3">
                  <Card className="p-4 practice-question">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-2xs font-semibold text-ink-soft">
                        {activeIndex + 1}/{practiceSet.questions.length}
                      </span>
                      <span className="num flex items-center gap-1 font-mono text-2xs text-muted">
                        <Timer size={11} />
                        {formatElapsedTime(elapsedMs)}
                      </span>
                      <span className="num text-2xs text-muted">Attempt {attemptNumber}</span>
                      <span className="text-2xs text-muted">
                        {question.type.replace('-', ' ')} · {question.difficulty}
                        {question.topics.length > 0
                          ? ` · ${question.topics.map((topic) => topicLabel(topic)).join(' · ')}`
                          : ''}
                      </span>
                      {flaggedCurrent ? (
                        <Badge tone="warn">
                          {/* Filled like the navigator's flag, so both states of
                              "flagged" read as the same mark. */}
                          <Flag size={9} fill="currentColor" /> flagged
                        </Badge>
                      ) : null}
                      <span className="ml-auto text-2xs text-muted">
                        ~{question.estimatedMinutes} min · {question.schemaTables.join(', ')}
                      </span>
                      <Button
                        variant="tertiary"
                        size="sm"
                        aria-pressed={schemaPanelVisible}
                        tooltip="Toggle schema browser (Ctrl/Cmd+B)"
                        tooltipSide="bottom"
                        icon={<PanelRight size={12} />}
                        onClick={toggleSchemaPanel}
                      >
                        Schema
                      </Button>
                    </div>

                    <h2 className="mt-3 text-lg font-extrabold tracking-tight">{question.title}</h2>
                    <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                      {question.scenario}
                    </div>

                    {question.brokenSql ? (
                      <div className="mt-3">
                        <div className="mono-label mb-1">
                          {question.type === 'fix-query'
                            ? 'Broken / inefficient query'
                            : 'Query to review'}
                        </div>
                        <CodeBlock text={question.brokenSql} className="max-h-52 text-2xs" />
                      </div>
                    ) : null}

                    <QuestionHints
                      question={question}
                      shown={hintsShown}
                      onReveal={() => setHintsShown((value) => Math.min(hintTierCount, value + 1))}
                    />
                  </Card>

                  {question.type === 'write-query' || question.type === 'fix-query' ? (
                    <div className="min-h-[380px] flex-1 overflow-hidden rounded-xl border border-line-soft bg-canvas">
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
                    <div className="min-h-[380px] flex-1 overflow-hidden rounded-xl border border-line-soft bg-canvas p-3">
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
                    <details open className="rounded-xl border border-line-soft bg-panel-2 p-2">
                      <summary className="cursor-pointer rounded-md px-2 py-2 text-2xs font-semibold text-muted">
                        Query result
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
                      <span className="text-2xs text-muted">
                        {running
                          ? 'Running the query…'
                          : `Ctrl+Enter runs against ${pinnedDatabase ?? 'the database'} without submitting; Alt+S submits; Submit grades it.`}
                      </span>
                    )}
                  </div>
                  {/* Released by the server only after this question was attempted. */}
                  {reference ? (
                    <Card className="p-4">
                      <details>
                        <summary className="cursor-pointer rounded-md px-2 py-2 text-2xs font-semibold text-muted">
                          Reference solution
                        </summary>
                        {reference.brokenSql && question.type !== 'fix-query' ? (
                          <>
                            <div className="mono-label mt-2">Query under review</div>
                            <CodeBlock text={reference.brokenSql} className="mt-1 text-2xs" />
                          </>
                        ) : null}
                        {reference.referenceSql ? (
                          <CodeBlock text={reference.referenceSql} className="mt-2 text-2xs" />
                        ) : (
                          <div className="mt-2 text-2xs text-muted">
                            This challenge has no reference SQL; compare with the feedback above.
                          </div>
                        )}
                        {reference.expectedResult ? (
                          <div className="mt-2 text-2xs text-muted">
                            Expected: {reference.expectedResult}
                          </div>
                        ) : null}
                        {reference.orderMatters ? (
                          <div className="mt-2 text-2xs text-muted">row order matters</div>
                        ) : null}
                      </details>
                    </Card>
                  ) : null}

                  {evaluation ? (
                    <Card className="p-4 card-enter">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                        <ScoreRing score={evaluation.scores.overall} size={112} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            {/* The wrapper carries the success pulse so the
                                shared Badge stays untouched. The pill radius
                                is set inline because .pulse-success's
                                `border-radius: inherit` (an unlayered rule)
                                would otherwise pull this row's square corner
                                over any utility class. */}
                            <span
                              className={cn(verdictPulse && 'pulse-success')}
                              style={{ borderRadius: '9999px' }}
                            >
                              <Badge tone={verdictTone(evaluation.verdict)}>
                                {evaluation.verdict === 'not-executed'
                                  ? 'reviewed'
                                  : evaluation.verdict.replace('-', ' ')}
                              </Badge>
                            </span>
                            <span className="text-2xs text-muted">
                              {evaluation.executed ? 'executed read-only' : 'not executed'}
                              {current.duplicate ? ' · duplicate answer' : ''}
                            </span>
                          </div>
                          <div className="mt-2 text-sm text-ink-soft">{evaluation.summary}</div>
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
                              Correctness 60% (result comparison) · performance 25% (rules and
                              EXPLAIN) · style 15% (readability). Non-executed answers use the AI
                              evaluation only.
                            </div>
                          </details>
                        </div>
                      </div>

                      {/*
                       * The detail sections of the evaluation form one group:
                       * the wrapper owns the spacing (gap-4), so each section
                       * renders the same whether its neighbours exist or not.
                       */}
                      <div className="mt-4 flex flex-col gap-4">
                        {evaluation.comparison ? (
                          <div>
                            <div className="section-title mb-2">Result comparison</div>
                            <ComparisonView comparison={evaluation.comparison} />
                          </div>
                        ) : null}

                        {evaluation.strengths.length > 0 || evaluation.issues.length > 0 ? (
                          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                            {evaluation.strengths.length > 0 ? (
                              <div className="rounded-xl border border-mint/20 bg-mint/5 p-3">
                                <div className="section-title mb-1 text-mint">What worked</div>
                                {evaluation.strengths.map((item, index) => (
                                  <div key={index} className="text-xs text-ink-soft">
                                    • {item}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {evaluation.issues.length > 0 ? (
                              <div className="rounded-xl border border-warn/20 bg-warn/5 p-3">
                                <div className="section-title mb-1 text-warn">What to fix</div>
                                {evaluation.issues.map((item, index) => (
                                  <div key={index} className="text-xs text-ink-soft">
                                    • {item}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        <div className="callout flex items-start gap-2">
                          <Lightbulb size={14} className="mt-0.5 shrink-0 text-ember" />
                          <div className="text-xs text-ink-soft">{evaluation.nextHint}</div>
                        </div>

                        {evaluation.aiFeedback ? (
                          <div>
                            <div className="section-title mb-2">AI feedback</div>
                            <Markdown>{evaluation.aiFeedback}</Markdown>
                          </div>
                        ) : null}

                        {evaluation.findings.length > 0 ? (
                          <div>
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
                          <details className="rounded-xl border border-line-soft bg-panel-2 p-3">
                            <summary className="cursor-pointer rounded-md px-2 py-2 text-2xs font-semibold text-muted">
                              EXPLAIN plan for your answer
                            </summary>
                            <div className="mt-2">
                              <ExplainPanel explain={evaluation.explain} analyzing={false} />
                            </div>
                          </details>
                        ) : null}

                        {evaluation.userResult || evaluation.referenceResult ? (
                          <div className="flex flex-col gap-2">
                            {evaluation.userResult ? (
                              <details className="rounded-xl border border-line-soft bg-panel-2 p-2">
                                <summary className="cursor-pointer rounded-md px-2 py-2 text-2xs font-semibold text-muted">
                                  Your result
                                </summary>
                                <div className="mt-1 max-h-[320px] overflow-auto rounded-lg border border-line-soft">
                                  <ResultsGrid result={evaluation.userResult} />
                                </div>
                              </details>
                            ) : null}
                            {evaluation.referenceResult ? (
                              <details className="rounded-xl border border-line-soft bg-panel-2 p-2">
                                <summary className="cursor-pointer rounded-md px-2 py-2 text-2xs font-semibold text-muted">
                                  Reference result
                                </summary>
                                <div className="mt-1 max-h-[320px] overflow-auto rounded-lg border border-line-soft">
                                  <ResultsGrid result={evaluation.referenceResult} />
                                </div>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

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
                          variant="tertiary"
                          size="sm"
                          className="ml-auto"
                          onClick={() => {
                            updateCurrent({ evaluation: null, duplicate: false });
                          }}
                        >
                          Retry
                        </Button>
                      </div>
                    </Card>
                  ) : null}
                </div>

                {schemaPanelOpen ? (
                  /*
                   * The right stack: the question tracker on top, the tables
                   * panel under it. The panel hugs its content and scrolls
                   * the tree inside a bounded box, so it stays a panel next
                   * to the taller first column instead of stretching down
                   * with the results.
                   *
                   * h-0 + min-h-full keeps the wrapper out of the row's
                   * height calculation: without it the panel would decide how
                   * tall the row is, and expanding a table would resize the
                   * editor.
                   */
                  <aside className="hidden h-0 min-h-full flex-col gap-3 lg:flex">
                    {practiceSet && navigatorOpen ? (
                      <div className="practice-nav panel-enter" aria-label="Question navigator">
                        <QuestionTracker
                          set={practiceSet}
                          answers={answers}
                          flagged={flagged}
                          activeIndex={activeIndex}
                          answeredCount={answeredCount}
                          flaggedCurrent={flaggedCurrent}
                          canFlag={Boolean(question)}
                          onGoTo={goTo}
                          onToggleFlag={() => {
                            if (question) toggleFlag(question.id);
                          }}
                          onHide={() => setNavigatorOpen(false)}
                        />
                      </div>
                    ) : null}
                    <div className="panel-enter sticky top-4 flex flex-col overflow-hidden rounded-xl border border-line-soft bg-panel">
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
              className="scrim-enter absolute inset-0 bg-black/60"
              onClick={() => setSchemaDrawerOpen(false)}
            />
            <aside className="drawer-enter absolute inset-y-0 right-0 flex w-[min(88vw,360px)] flex-col border-l border-line bg-panel">
              <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
                <span className="text-2xs font-semibold text-ink">Schema</span>
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
        message="Removes attempt history for this connection. Saved sets remain."
        confirmLabel="Clear attempts"
        danger
      />

      {/*
       * The tutor only exists while a challenge is open: without one there is
       * nothing for it to explain, and the server needs the challenge id to
       * keep the answer material out of the prompt.
       */}
      {practiceSet && question ? (
        <AiAssistant
          mode="challenge"
          title="Coach"
          notice="Explains the challenge in plain words. It will not write the answer for you."
          emptyHint="Ask what the challenge is asking, or what a JOIN or GROUP BY actually does."
          placeholder="Ask about this challenge…"
          context={{
            profileId: activeProfileId,
            database: pinnedDatabase,
            question: { setId: practiceSet.id, questionId: question.id },
          }}
          history={{
            turns: coachTurns[question.id] ?? NO_COACH_TURNS,
            onChange: (turns) => {
              const questionId = question.id;
              setCoachTurns((current) => ({ ...current, [questionId]: turns }));
            },
          }}
          resetKey={question.id}
        />
      ) : null}
    </div>
  );
}
