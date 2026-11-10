import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EditorView } from '@codemirror/view';
import { format as formatSql } from 'sql-formatter';
import {
  Bookmark,
  ChevronDown,
  Database,
  FileSearch,
  History,
  Info,
  Lock,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  ScanSearch,
  SquareTerminal,
  Table2,
  Unlock,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import type { AiReview, HistoryEntry, Snippet, StatementClassification } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { useWorkspaceStore, type QueryTab } from '@/store/workspace-store';
import { useUiStore } from '@/store/ui-store';
import { ApiError } from '@/lib/api';
import { dbApi } from '@/lib/db-api';
import { postSse } from '@/lib/sse';
import { onWorkspace, type WorkspaceAction } from '@/lib/events';
import { formatDuration, sqlPreview } from '@/lib/format';
import { selectDatabaseHint } from '@/lib/copy';
import {
  FORMAT_INDENT_CHOICES,
  FORMAT_KEYWORD_CASE_CHOICES,
  FORMAT_LINES_CHOICES,
  sqlFormatterOptions,
} from '@/lib/sql-snippets';
import { SqlEditor } from '@/components/SqlEditor';
import { SchemaSidebar } from '@/components/SchemaSidebar';
import { ResultsGrid } from '@/components/ResultsGrid';
import { ExplainPanel } from '@/components/ExplainPanel';
import { ReviewPanel } from '@/components/ReviewPanel';
import { AiAssistant } from '@/components/AiAssistant';
import { UnlockDialog } from '@/components/UnlockDialog';
import { WorkspaceModals } from '@/components/WorkspaceModals';
import { Badge, Button, EmptyState, IconButton, Spinner, Tabs } from '@/components/ui';
import { cn } from '@/lib/utils';

/** Editor/results split bounds, mirrored from the ui store clamp. */
const SPLITTER_MIN = 20;
const SPLITTER_MAX = 78;

/**
 * Rubber-band resistance: past a bound the split follows the pointer at 15%
 * of the overshoot, so the edge stretches like a band and snaps back on
 * release (`resistSplit` below).
 */
const SPLIT_RESIST = 0.15;

/** How long the snap-back transition runs (`.editor-wrap.settling` in editor.css). */
const SPLIT_SETTLE_MS = 200;

/** How long the format menu stays mounted while its pop-out exit plays
    (`.pop-out` runs 120ms — `--duration-exit` — plus a small buffer). */
const FORMAT_MENU_EXIT_MS = 130;

/**
 * The displayed split for a raw drag percentage: inside the bounds it is the
 * raw value itself; past a bound only `SPLIT_RESIST` of the overshoot is
 * shown, so the edge resists like a rubber band. The raw value is fenced to
 * 0–100 first — the pointer cannot leave the window, and a wild value must
 * not stretch the band absurdly far.
 */
// eslint-disable-next-line react-refresh/only-export-components -- imported by the workspace UI tests; a shared lib file is outside this change
export function resistSplit(raw: number): number {
  const fenced = Math.max(0, Math.min(100, raw));
  if (fenced < SPLITTER_MIN) return SPLITTER_MIN + (fenced - SPLITTER_MIN) * SPLIT_RESIST;
  if (fenced > SPLITTER_MAX) return SPLITTER_MAX + (fenced - SPLITTER_MAX) * SPLIT_RESIST;
  return fenced;
}

/**
 * The height of the status bar along the bottom of the workspace, in pixels
 * (`.statusbar` in styles/features/editor.css). The floating assistant button
 * is lifted by this much, so it never sits on top of the bar.
 */
const STATUS_BAR_HEIGHT = 26;

/**
 * The height of the results-grid pagination footer, in pixels (the
 * `border-t px-3 py-2` band at the bottom of the grid), plus the gap the
 * floating assistant button keeps above it.
 *
 * The button is lifted by the status bar (how far the pane bottom sits above
 * the window edge) plus this clearance, so it comes to rest on the grid's
 * bottom-right corner instead of covering the Prev/Next controls — and the
 * pane itself no longer needs a reserved dead band for it.
 */
const RESULTS_FOOTER_HEIGHT = 40;
const ASSISTANT_CLEARANCE = 8;
const ASSISTANT_FAB_INSET = STATUS_BAR_HEIGHT + RESULTS_FOOTER_HEIGHT + ASSISTANT_CLEARANCE;

function MessagesPanel({ tab }: { tab: QueryTab }) {
  const result = tab.result;
  return (
    <div className="flex flex-col gap-3 p-3">
      {tab.error ? (
        <div className="callout danger flex items-start gap-2">
          <XCircle size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-mono text-micro uppercase tracking-wide text-danger">
              {tab.error.code}
            </div>
            <div className="mt-1 text-xs text-ink">{tab.error.message}</div>
            {tab.error.details ? (
              <pre className="finding-evidence mt-2 whitespace-pre-wrap">
                {JSON.stringify(tab.error.details, null, 2)}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="stat-grid stat-grid-4">
          <div className="stat">
            <div className="stat-label">Statement</div>
            <div className="stat-value text-sm uppercase">{result.kind}</div>
            <div className="stat-sub">{formatDuration(result.executionMs)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Rows</div>
            <div className="stat-value">{result.rowCount.toLocaleString()}</div>
            <div className="stat-sub">{result.truncated ? 'capped' : 'returned'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Affected</div>
            <div className="stat-value">{result.affectedRows.toLocaleString()}</div>
            <div className="stat-sub">
              {result.insertId ? `insert id ${result.insertId}` : 'rows changed'}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Payload</div>
            <div className="stat-value text-md">{(result.bytesApprox / 1024).toFixed(1)} KB</div>
            <div className="stat-sub">serialized result</div>
          </div>
        </div>
      ) : null}

      {result?.info ? (
        <div className="callout flex items-start gap-2">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span className="font-mono text-2xs">{result.info}</span>
        </div>
      ) : null}

      {result && result.warnings.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="section-title">Warnings</div>
          {result.warnings.map((warning, index) => (
            <div key={index} className="callout flex items-start gap-2">
              <Info size={13} className="mt-0.5 shrink-0 text-warn" />
              <div>
                <span className="font-mono text-2xs text-warn">
                  {warning.level} {warning.code}
                </span>
                <div className="text-xs">{warning.message}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!tab.error && !result ? <EmptyState icon={<Info size={20} />} title="No messages" /> : null}
    </div>
  );
}

/**
 * The right-hand end of the output strip: the result badges and the control
 * that swaps between the editor and the results.
 *
 * The row count and the duration are not repeated here — the grid below
 * carries them, and the status bar carries the runtime. The review score is
 * not shown here either — the ReviewPanel's ScoreRing is its single surface.
 */
export function OutputMeta({
  hasAi,
  resultsMaximized,
  onToggleMaximized,
}: {
  hasAi: boolean;
  resultsMaximized: boolean;
  onToggleMaximized: () => void;
}) {
  return (
    <div className="ml-auto flex items-center gap-2 px-3 text-2xs text-muted">
      {hasAi ? <Badge tone="info">AI</Badge> : null}
      <Button
        variant="tertiary"
        size="sm"
        icon={resultsMaximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
        onClick={onToggleMaximized}
        tooltip={resultsMaximized ? 'Show the editor (Esc)' : 'Maximize results'}
        tooltipSide="top"
      >
        {resultsMaximized ? 'Show editor' : 'Maximize'}
      </Button>
    </div>
  );
}

/**
 * The pane that holds the output tab that is open.
 *
 * No bottom band is reserved for the floating assistant button: the button is
 * lifted above the pagination footer instead (`ASSISTANT_FAB_INSET`), so rows
 * run the full pane height and the footer sits flush against the status bar.
 */
export function OutputPane({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-auto">{children}</div>;
}

/** One labeled row of choices inside the format-options menu. */
function FormatOptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-3 py-1.5">
      <div className="text-micro uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 flex gap-1">{children}</div>
    </div>
  );
}

/** A single radio-style choice inside the format-options menu. */
function FormatOptionButton({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={cn(
        'rounded px-2 py-1 text-2xs transition',
        selected
          ? 'bg-ember/15 font-semibold text-ink'
          : 'text-ink-soft hover:bg-panel-3 hover:text-ink',
      )}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

export function WorkspacePage() {
  const navigate = useNavigate();
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const selectedDatabase = useAppStore((state) => state.selectedDatabase);
  const server = useAppStore((state) => state.server);
  const schema = useAppStore((state) => state.schema);
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const currentUser = useAppStore((state) => state.currentUser);
  const unlockedUntil = useAppStore((state) => state.unlockedUntil);
  const toast = useAppStore((state) => state.toast);
  const refreshSchema = useAppStore((state) => state.refreshSchema);
  const refreshObjects = useAppStore((state) => state.refreshObjects);
  const refreshDatabases = useAppStore((state) => state.refreshDatabases);
  const lockWrites = useAppStore((state) => state.lockWrites);
  const editorPct = useUiStore((state) => state.editorPct);
  const setEditorPct = useUiStore((state) => state.setEditorPct);
  const resultsMaximized = useUiStore((state) => state.resultsMaximized);
  const toggleResultsMaximized = useUiStore((state) => state.toggleResultsMaximized);
  const setResultsMaximized = useUiStore((state) => state.setResultsMaximized);
  const formatKeywordCase = useUiStore((state) => state.formatKeywordCase);
  const formatIndent = useUiStore((state) => state.formatIndent);
  const formatLinesBetweenQueries = useUiStore((state) => state.formatLinesBetweenQueries);
  const setFormatOptions = useUiStore((state) => state.setFormatOptions);

  const tabs = useWorkspaceStore((state) => state.tabs);
  const activeId = useWorkspaceStore((state) => state.activeId);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const setActive = useWorkspaceStore((state) => state.setActive);
  const updateSql = useWorkspaceStore((state) => state.updateSql);
  const patchTab = useWorkspaceStore((state) => state.patchTab);
  const setOutputTab = useWorkspaceStore((state) => state.setOutputTab);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const viewRef = useRef<EditorView | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  /** Latest run sequence per tab, so a superseded response cannot patch state. */
  const runSeqRef = useRef<Map<string, number>>(new Map());
  const editorAreaRef = useRef<HTMLDivElement>(null);
  /** Active splitter drag, captured on pointer down so moves stay relative to the grab point. */
  const splitterDragRef = useRef<{
    pointerId: number;
    startY: number;
    startPct: number;
    areaHeight: number;
    /** The raw, unresisted pointer percentage of the latest move. */
    raw: number;
  } | null>(null);
  const revealNextRef = useRef(false);
  const [schemaDrawerOpen, setSchemaDrawerOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockClassification, setUnlockClassification] = useState<StatementClassification | null>(
    null,
  );
  const [pendingText, setPendingText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  // True while the modal-open fetch runs, so a first open shows shimmer
  // lines instead of silently sitting on the empty state.
  const [snippetsLoading, setSnippetsLoading] = useState(false);
  const [snippetTitle, setSnippetTitle] = useState('');
  const [snippetTags, setSnippetTags] = useState('');
  const [snippetBusy, setSnippetBusy] = useState(false);
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [formatMenuWasOpen, setFormatMenuWasOpen] = useState(false);
  const [formatMenuClosing, setFormatMenuClosing] = useState(false);
  const formatMenuRef = useRef<HTMLDivElement | null>(null);
  /**
   * The displayed split while a drag is live: the rubber-banded value. The
   * store clamps and rounds, so it cannot hold the overshoot — the clamped
   * value is committed on release.
   */
  const [dragPct, setDragPct] = useState<number | null>(null);
  /** True right after a drag released past a bound, so the snap back animates. */
  const [splitSettling, setSplitSettling] = useState(false);

  // Adjusting state as the menu toggles keeps it mounted through its exit
  // animation, so it can pop back into its trigger instead of vanishing —
  // the same render-time adjustment the modal uses.
  if (formatMenuOpen !== formatMenuWasOpen) {
    setFormatMenuWasOpen(formatMenuOpen);
    if (formatMenuOpen) setFormatMenuClosing(false);
    else setFormatMenuClosing(true);
  }

  useEffect(() => {
    if (!formatMenuClosing) return;
    const timer = window.setTimeout(() => setFormatMenuClosing(false), FORMAT_MENU_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [formatMenuClosing]);

  useEffect(() => {
    if (!splitSettling) return;
    const timer = window.setTimeout(() => setSplitSettling(false), SPLIT_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [splitSettling]);

  const isAdmin = currentUser?.role === 'admin';

  // `unlockedUntil` is an absolute timestamp. The clock is read in an effect
  // so the flag flips exactly when the unlock window closes, instead of
  // reading the time while rendering.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!unlockedUntil) return;
    const remaining = unlockedUntil - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [unlockedUntil]);

  const unlocked = isAdmin || Boolean(unlockedUntil && unlockedUntil > now);

  // Saved snippets are also editor completions, so they are loaded once on
  // mount (silently — the modal reports its own errors) and refreshed by
  // `saveSnippet`.
  useEffect(() => {
    let cancelled = false;
    dbApi
      .snippets()
      .then((loaded) => {
        if (!cancelled) setSnippets(loaded);
      })
      .catch(() => {
        // The completion list simply stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The format-options menu closes on any click outside of it, and on Escape.
  useEffect(() => {
    if (!formatMenuOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (!formatMenuRef.current?.contains(event.target as Node)) setFormatMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFormatMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [formatMenuOpen]);

  const patch = (patchValue: Partial<QueryTab>): void => {
    if (activeTab) patchTab(activeTab.id, patchValue);
  };

  const readText = (selectionOnly: boolean): { text: string; cursorOffset?: number } => {
    const view = viewRef.current;
    if (view) {
      const selection = view.state.selection.main;
      if (selectionOnly) {
        if (selection.from !== selection.to) {
          return { text: view.state.sliceDoc(selection.from, selection.to) };
        }
        // No selection: run the statement the caret is in. The server splits
        // the script and picks the one under this offset, so the buffer does
        // not have to be trimmed by hand.
        return { text: activeTab?.sql ?? '', cursorOffset: selection.from };
      }
    }
    return { text: activeTab?.sql ?? '' };
  };

  const insertText = (text: string): void => {
    const view = viewRef.current;
    if (view) {
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
      return;
    }
    if (activeTab) {
      const current = activeTab.sql;
      updateSql(activeTab.id, `${current}${text}`);
    }
  };

  const jumpToLine = (line: number): void => {
    const view = viewRef.current;
    if (!view) return;
    const safe = Math.max(1, Math.min(view.state.doc.lines, line));
    const position = view.state.doc.line(safe).from;
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    view.focus();
  };

  const handleLocked = (error: ApiError, text: string): boolean => {
    if (isAdmin || error.code !== 'WRITE_LOCKED') return false;
    const details = error.details as { classification?: StatementClassification } | undefined;
    setUnlockClassification(details?.classification ?? null);
    setPendingText(text);
    setUnlockOpen(true);
    return true;
  };

  const revealSensitiveValues = (): void => {
    // Re-run exactly what produced the masked result, not whatever the editor
    // holds now (the user may have typed since the last run).
    const executed = activeTab?.executedSql?.trim();
    if (!executed) {
      toast('Run the statement before revealing sensitive values.', 'warn');
      return;
    }
    revealNextRef.current = true;
    void execute(executed);
  };

  const execute = async (override?: string, cursorOffset?: number): Promise<void> => {
    const reveal = revealNextRef.current;
    revealNextRef.current = false;
    const raw = override ?? readText(false).text;
    const text = raw.trim();
    // The caret offset is relative to the untrimmed editor text, but the
    // server is given the trimmed statement, so the offset moves with the
    // leading whitespace.
    const leading = raw.length - raw.trimStart().length;
    const offset = cursorOffset === undefined ? undefined : Math.max(0, cursorOffset - leading);
    if (!text) {
      toast('There is no SQL to run.', 'warn');
      return;
    }
    if (!activeProfileId) {
      toast('Select a connection first.', 'warn');
      return;
    }
    if (!activeTab) return;
    const tabId = activeTab.id;
    // Every run on this tab supersedes the previous one; only the newest
    // response is allowed to patch the tab.
    const seq = (runSeqRef.current.get(tabId) ?? 0) + 1;
    runSeqRef.current.set(tabId, seq);
    const isCurrent = (): boolean => runSeqRef.current.get(tabId) === seq;

    patchTab(tabId, { running: true, error: null, outputTab: 'results', executedSql: text });
    try {
      const result = await dbApi.run(activeProfileId, text, selectedDatabase, {
        revealSensitive: reveal,
        cursorOffset: offset,
      });
      if (result.kind === 'write' || result.kind === 'ddl' || result.kind === 'admin') {
        setTimeout(() => {
          void refreshSchema(true);
          void refreshObjects();
          void refreshDatabases();
        }, 220);
      }
      if (!isCurrent()) return;
      // Re-state `executedSql`: an edit made while the query was in flight
      // cleared it, but this result still belongs to `text`.
      patchTab(tabId, {
        running: false,
        result,
        error: null,
        outputTab: 'results',
        executedSql: text,
      });
    } catch (error) {
      if (!isCurrent()) return;
      patchTab(tabId, { running: false });
      // A locked write opens the unlock dialog; the previous result stays valid
      // unless the user proceeds with the unlocked statement.
      if (error instanceof ApiError && handleLocked(error, text)) return;
      const apiError = error instanceof ApiError ? error : null;
      patchTab(tabId, {
        // The failure belongs to this run, so the previous rows must not linger
        // next to the new error.
        result: null,
        error:
          apiError ??
          new ApiError('UNKNOWN', error instanceof Error ? error.message : String(error), 500),
        outputTab: 'messages',
      });
      toast(apiError?.message ?? String(error), 'error');
    }
  };

  const runSelection = (): void => {
    const { text, cursorOffset } = readText(true);
    if (!text.trim()) {
      toast('Select a statement or place the cursor in the editor.', 'warn');
      return;
    }
    void execute(text, cursorOffset);
  };

  const explain = async (withAnalyze = false): Promise<void> => {
    const text = readText(false).text.trim();
    if (!text) {
      toast('There is no SQL to explain.', 'warn');
      return;
    }
    if (!activeProfileId) return;
    if (withAnalyze) setAnalyzing(true);
    patch({ explaining: true, outputTab: 'explain', error: null });
    try {
      const result = await dbApi.explain(activeProfileId, text, selectedDatabase, withAnalyze);
      patch({ explaining: false, explain: result, outputTab: 'explain' });
    } catch (error) {
      patch({ explaining: false });
      if (error instanceof ApiError && handleLocked(error, text)) return;
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  const review = async (): Promise<void> => {
    const text = readText(false).text.trim();
    if (!text) {
      toast('There is no SQL to review.', 'warn');
      return;
    }
    if (!activeProfileId) return;
    patch({ reviewing: true, outputTab: 'review', error: null });
    try {
      const result = await dbApi.review(
        activeProfileId,
        text,
        selectedDatabase,
        false,
        settings.includeSchemaByDefault,
      );
      patch({ reviewing: false, review: result, outputTab: 'review' });
    } catch (error) {
      patch({ reviewing: false });
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const appendAiRaw = (text: string): void => {
    if (!activeTab) return;
    useWorkspaceStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === activeTab.id ? { ...tab, aiRaw: tab.aiRaw + text } : tab,
      ),
    }));
  };

  const deepReview = async (options: {
    providerId: string;
    model: string;
    includeSchema: boolean;
    includeExplain: boolean;
    analyze: boolean;
  }): Promise<void> => {
    const text = readText(false).text.trim();
    if (!text) {
      toast('There is no SQL to review.', 'warn');
      return;
    }
    if (!activeProfileId) return;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    patch({
      aiRunning: true,
      aiStreaming: false,
      aiRaw: '',
      aiError: null,
      ai: null,
      outputTab: 'review',
    });
    const body = dbApi.aiReviewBody({
      profileId: activeProfileId,
      database: selectedDatabase,
      statement: text,
      providerId: options.providerId,
      model: options.model,
      includeSchema: options.includeSchema,
      includeExplain: options.includeExplain,
      analyze: options.analyze,
      findings: activeTab?.review?.findings,
      explain: activeTab?.review?.explain,
    });
    try {
      await postSse(
        '/api/review/ai',
        body,
        {
          onEvent: ({ event, data }) => {
            // A superseded run must not touch the tab the newer run owns.
            if (aiAbortRef.current !== controller) return;
            if (event === 'delta') {
              const payload = data as { text?: string };
              if (payload.text) {
                appendAiRaw(payload.text);
                patch({ aiStreaming: true });
              }
            } else if (event === 'result') {
              const payload = data as { review?: AiReview };
              if (payload.review) {
                patch({
                  ai: payload.review,
                  aiRunning: false,
                  aiStreaming: false,
                  aiError: null,
                });
              }
            } else if (event === 'error') {
              const payload = data as { message?: string };
              patch({
                aiRunning: false,
                aiStreaming: false,
                aiError: payload.message ?? 'The AI provider returned an error.',
              });
            } else if (event === 'done') {
              patch({ aiRunning: false, aiStreaming: false });
            }
          },
        },
        controller.signal,
      );
    } catch (error) {
      if (aiAbortRef.current === controller && (error as Error).name !== 'AbortError') {
        patch({
          aiRunning: false,
          aiStreaming: false,
          aiError: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        patch({ aiRunning: false, aiStreaming: false });
      }
    }
  };

  const cancelAi = (): void => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    patch({ aiRunning: false, aiStreaming: false });
  };

  const saveReport = async (): Promise<void> => {
    if (!activeTab) return;
    if (!activeTab.review && !activeTab.ai) {
      toast('Run a review first.', 'warn');
      return;
    }
    const text = activeTab.executedSql ?? activeTab.sql;
    try {
      await dbApi.saveReview({
        profileId: activeProfileId,
        database: selectedDatabase,
        statement: text,
        includeExplain: Boolean(activeTab.review?.explain),
        ai: activeTab.ai,
      });
      toast('Review saved to Reports.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const formatCurrent = (): void => {
    if (!activeTab) return;
    const formatterOptions = sqlFormatterOptions({
      keywordCase: formatKeywordCase,
      indent: formatIndent,
      linesBetweenQueries: formatLinesBetweenQueries,
    });
    const format = (sql: string): string => formatSql(sql, formatterOptions);
    // With a selection, only the selected range is rewritten; the rest of the
    // buffer stays exactly as the user left it.
    const view = viewRef.current;
    const selection = view?.state.selection.main;
    if (view && selection && selection.from !== selection.to) {
      try {
        const formatted = format(view.state.sliceDoc(selection.from, selection.to));
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: formatted },
        });
        view.focus();
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Could not format the SQL.', 'warn');
      }
      return;
    }
    const current = activeTab.sql;
    try {
      const formatted = format(current);
      updateSql(activeTab.id, formatted);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not format the SQL.', 'warn');
    }
  };

  const openHistory = async (): Promise<void> => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      setHistory(await dbApi.history(activeProfileId ?? ''));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadHistory = (entry: HistoryEntry, inNewTab: boolean): void => {
    const restored = entry.sql;
    if (inNewTab) createTab(restored);
    else if (activeTab) updateSql(activeTab.id, restored);
    setHistoryOpen(false);
    // History stores the statement with its literals redacted, so a restored
    // statement can contain `?` placeholders where values used to be. Say so
    // rather than letting the user run a statement that quietly lost its data.
    if (/\?/.test(restored)) {
      toast(
        'Values were removed from the stored statement. Re-enter any placeholders before running it.',
        'warn',
      );
    }
  };

  const openSnippets = async (): Promise<void> => {
    setSnippetsOpen(true);
    setSnippetsLoading(true);
    try {
      setSnippets(await dbApi.snippets());
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setSnippetsLoading(false);
    }
  };

  const saveSnippet = async (): Promise<void> => {
    if (!activeTab) return;
    setSnippetBusy(true);
    const statement = activeTab.sql;
    try {
      await dbApi.saveSnippet(
        snippetTitle.trim() || sqlPreview(statement, 40) || 'Snippet',
        statement,
        snippetTags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      );
      setSnippets(await dbApi.snippets());
      setSnippetTitle('');
      setSnippetTags('');
      toast('Snippet saved.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setSnippetBusy(false);
    }
  };

  const deleteSnippet = async (id: string): Promise<void> => {
    try {
      await dbApi.deleteSnippet(id);
      setSnippets((current) => current.filter((snippet) => snippet.id !== id));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const clearHistory = async (): Promise<void> => {
    try {
      await dbApi.clearHistory(activeProfileId ?? '');
      setHistory([]);
      toast('History cleared.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const openTable = (table: string): void => {
    navigate(
      `/database?db=${encodeURIComponent(selectedDatabase ?? '')}&table=${encodeURIComponent(table)}`,
    );
  };

  const splitterPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) return;
    const area = editorAreaRef.current;
    if (!area) return;
    event.preventDefault();
    // A fresh drag must follow the pointer directly: drop any snap-back
    // transition still running from the previous release.
    setDragPct(null);
    setSplitSettling(false);
    const rect = area.getBoundingClientRect();
    splitterDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startPct: editorPct,
      areaHeight: rect.height,
      raw: editorPct,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  };

  const splitterPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = splitterDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaPct = ((event.clientY - drag.startY) / drag.areaHeight) * 100;
    const raw = drag.startPct + deltaPct;
    drag.raw = raw;
    // The store clamps and rounds, so the overshoot lives in local display
    // state; the clamped value is committed when the drag ends.
    setDragPct(resistSplit(raw));
  };

  const splitterPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = splitterDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    splitterDragRef.current = null;
    setDragPct(null);
    // `setEditorPct` clamps to the bound. Released past it, `.settling`
    // animates the snap back; released inside, the display already matches
    // the committed value (at most the store's rounding step).
    setEditorPct(drag.raw);
    if (drag.raw < SPLITTER_MIN || drag.raw > SPLITTER_MAX) setSplitSettling(true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const splitterKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    let next: number;
    switch (event.key) {
      case 'ArrowUp':
        next = editorPct - 2;
        break;
      case 'ArrowDown':
        next = editorPct + 2;
        break;
      case 'PageUp':
        next = editorPct - 10;
        break;
      case 'PageDown':
        next = editorPct + 10;
        break;
      case 'Home':
        next = SPLITTER_MIN;
        break;
      case 'End':
        next = SPLITTER_MAX;
        break;
      default:
        return;
    }
    event.preventDefault();
    setEditorPct(next);
  };

  // The workspace event bus is global, so subscribe once and read the newest
  // handlers through a ref instead of re-subscribing on every render.
  const actionsRef = useRef({
    createTab,
    execute,
    runSelection,
    explain,
    review,
    formatCurrent,
    openHistory,
    openSnippets,
  });

  useEffect(() => {
    actionsRef.current = {
      createTab,
      execute,
      runSelection,
      explain,
      review,
      formatCurrent,
      openHistory,
      openSnippets,
    };
  });

  useEffect(() => {
    return onWorkspace((action: WorkspaceAction) => {
      const handlers = actionsRef.current;
      if (action === 'new-tab') handlers.createTab();
      if (action === 'run') void handlers.execute();
      if (action === 'run-selection') handlers.runSelection();
      if (action === 'explain') void handlers.explain(false);
      if (action === 'review') void handlers.review();
      if (action === 'format') handlers.formatCurrent();
      if (action === 'history') void handlers.openHistory();
      if (action === 'snippets') void handlers.openSnippets();
    });
  }, []);

  useEffect(() => {
    return () => {
      aiAbortRef.current?.abort();
      aiAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Browsers reserve Ctrl/Cmd+T for a new browser tab and cannot be
      // stopped with `preventDefault`, so the new tab lives on Alt+T. The
      // match is on the physical key (`code`): macOS turns Option+T into the
      // `™` character, so `event.key` never spells a plain `t` there.
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyT') {
        event.preventDefault();
        createTab();
      }
      if (event.key === 'Escape' && useUiStore.getState().resultsMaximized) {
        setResultsMaximized(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createTab, setResultsMaximized]);

  if (!activeTab) return null;

  const outputItems = [
    { id: 'results' as const, label: 'Results', count: activeTab.result?.rowCount },
    {
      id: 'messages' as const,
      label: 'Messages',
      count: (activeTab.error ? 1 : 0) + (activeTab.result?.warnings.length ?? 0),
    },
    {
      id: 'explain' as const,
      label: 'Explain',
      count: activeTab.explain?.insights.length,
    },
    {
      id: 'review' as const,
      label: 'Review',
      count: (activeTab.review?.findings.length ?? 0) + (activeTab.ai?.findings.length ?? 0),
    },
  ];

  const editorValue = activeTab.sql;
  /** Rubber-banded while a drag is live, the clamped store value otherwise. */
  const displayPct = dragPct ?? editorPct;

  return (
    <>
      <div className={cn('workspace', schemaDrawerOpen && 'schema-drawer-open')}>
        <div
          className={cn('schema-drawer-backdrop', schemaDrawerOpen && 'open')}
          onClick={() => setSchemaDrawerOpen(false)}
        />
        <SchemaSidebar
          onInsert={insertText}
          onOpenTable={openTable}
          onCloseMobile={() => setSchemaDrawerOpen(false)}
        />

        <div
          className={cn('workspace-main', resultsMaximized && 'results-maximized')}
          ref={editorAreaRef}
        >
          <div className="query-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  'group flex shrink-0 items-center gap-1 rounded-t-lg border border-b-0 px-2.5 py-1.5 text-2xs',
                  tab.id === activeId
                    ? 'border-line bg-panel text-ink'
                    : 'border-transparent text-muted hover:bg-panel-2 hover:text-ink-soft',
                )}
              >
                <button
                  type="button"
                  className="flex items-center gap-1.5"
                  onClick={() => setActive(tab.id)}
                >
                  {tab.running ? (
                    <Spinner size={10} />
                  ) : (
                    <SquareTerminal size={11} className={tab.id === activeId ? 'text-ember' : ''} />
                  )}
                  <span className="max-w-[150px] truncate">{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="rounded p-0.5 text-muted opacity-0 hover:bg-panel-3 hover:text-ink group-hover:opacity-100"
                  onClick={() => closeTab(tab.id)}
                  aria-label="Close tab"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <IconButton label="New statement tab (Alt+T)" onClick={() => createTab()}>
              <Plus size={14} />
            </IconButton>
          </div>

          <div className="toolbar">
            <Button
              variant="secondary"
              size="sm"
              className="schema-mobile-toggle"
              icon={<Table2 size={12} />}
              onClick={() => setSchemaDrawerOpen(true)}
            >
              Schema
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={activeTab.running ? <Spinner size={12} /> : <Play size={12} />}
              onClick={() => void execute()}
              disabled={activeTab.running}
            >
              Run
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Play size={12} />}
              onClick={runSelection}
              tooltip="Ctrl+Shift+Enter"
              tooltipSide="bottom"
            >
              Selection
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={activeTab.explaining ? <Spinner size={12} /> : <FileSearch size={12} />}
              onClick={() => void explain(false)}
              disabled={activeTab.explaining}
            >
              Explain
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={activeTab.reviewing ? <Spinner size={12} /> : <ScanSearch size={12} />}
              onClick={() => void review()}
              disabled={activeTab.reviewing}
              tooltip="Ctrl+Shift+R"
              tooltipSide="bottom"
            >
              Review
            </Button>
            <div className="toolbar-sep" aria-hidden="true" />
            <div className="relative flex items-center" ref={formatMenuRef}>
              <Button
                variant="tertiary"
                size="sm"
                icon={<Wand2 size={12} />}
                onClick={formatCurrent}
                tooltip="Format the selection, or the whole editor"
                tooltipSide="bottom"
              >
                Format
              </Button>
              <IconButton
                label="Format options"
                tooltip={false}
                className="-ml-1 px-1"
                aria-haspopup="menu"
                aria-expanded={formatMenuOpen}
                onClick={() => setFormatMenuOpen((open) => !open)}
              >
                <ChevronDown
                  size={11}
                  className={cn('transition', formatMenuOpen && 'rotate-180')}
                />
              </IconButton>
              {/* The items stay in the DOM while closed (`hidden`), so the menu
                  is plain markup that tests can see — same pattern as the
                  results grid's copy menu. While closing it stays mounted a
                  moment longer to pop back into the caret. */}
              <div
                role="menu"
                aria-label="Format options"
                hidden={!formatMenuOpen && !formatMenuClosing}
                className={cn(
                  'absolute left-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-xl border border-line bg-panel-2 py-1 shadow-lg',
                  formatMenuOpen && 'pop-in',
                  // `opacity-0` holds the menu invisible between the end of
                  // the pop-out animation and the unmount timer, whatever fill
                  // mode the utility uses.
                  formatMenuClosing && 'pop-out opacity-0',
                )}
                style={{ '--pop-origin': 'top right' } as CSSProperties}
              >
                <FormatOptionGroup label="Keyword case">
                  {FORMAT_KEYWORD_CASE_CHOICES.map((choice) => (
                    <FormatOptionButton
                      key={choice.value}
                      label={choice.label}
                      selected={formatKeywordCase === choice.value}
                      onSelect={() => setFormatOptions({ keywordCase: choice.value })}
                    />
                  ))}
                </FormatOptionGroup>
                <FormatOptionGroup label="Indent">
                  {FORMAT_INDENT_CHOICES.map((choice) => (
                    <FormatOptionButton
                      key={choice.value}
                      label={choice.label}
                      selected={formatIndent === choice.value}
                      onSelect={() => setFormatOptions({ indent: choice.value })}
                    />
                  ))}
                </FormatOptionGroup>
                <FormatOptionGroup label="Blank lines between queries">
                  {FORMAT_LINES_CHOICES.map((choice) => (
                    <FormatOptionButton
                      key={choice.value}
                      label={choice.label}
                      selected={formatLinesBetweenQueries === choice.value}
                      onSelect={() => setFormatOptions({ linesBetweenQueries: choice.value })}
                    />
                  ))}
                </FormatOptionGroup>
              </div>
            </div>
            <Button
              variant="tertiary"
              size="sm"
              icon={<Bookmark size={12} />}
              onClick={() => void openSnippets()}
            >
              Snippets
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              icon={<History size={12} />}
              onClick={() => void openHistory()}
            >
              History
            </Button>

            {!isAdmin ? (
              <div className="ml-auto flex items-center gap-2">
                {unlocked ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    icon={<Lock size={11} />}
                    onClick={() => void lockWrites()}
                  >
                    Lock writes
                  </Button>
                ) : (
                  <Button
                    variant="tertiary"
                    size="sm"
                    icon={<Unlock size={11} />}
                    onClick={() => {
                      setUnlockClassification(null);
                      setPendingText('');
                      setUnlockOpen(true);
                    }}
                  >
                    Unlock writes
                  </Button>
                )}
              </div>
            ) : null}
          </div>

          {!selectedDatabase ? (
            <div className="border-b border-warn/20 bg-warn/5 px-3 py-1.5 text-2xs text-warn">
              No database selected — {selectDatabaseHint}
            </div>
          ) : null}

          <div
            className={cn('editor-wrap', splitSettling && 'settling')}
            style={{ height: `${displayPct}%` }}
          >
            <SqlEditor
              value={editorValue}
              onChange={(value) => updateSql(activeTab.id, value)}
              schema={schema}
              snippets={snippets}
              profileId={activeProfileId}
              database={selectedDatabase}
              liveLint={settings.liveLint}
              onRun={() => void execute()}
              onRunSelection={runSelection}
              onReview={() => void review()}
              onReady={(view) => {
                viewRef.current = view;
              }}
            />
          </div>

          <div
            className="splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize editor and results panels"
            aria-valuenow={Math.round(displayPct)}
            aria-valuemin={SPLITTER_MIN}
            aria-valuemax={SPLITTER_MAX}
            aria-valuetext={`${Math.round(displayPct)}% editor height`}
            aria-keyshortcuts="ArrowUp ArrowDown PageUp PageDown Home End"
            tabIndex={0}
            onPointerDown={splitterPointerDown}
            onPointerMove={splitterPointerMove}
            onPointerUp={splitterPointerEnd}
            onPointerCancel={splitterPointerEnd}
            onKeyDown={splitterKeyDown}
          />

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center border-b border-line-soft">
              <Tabs
                items={outputItems}
                value={activeTab.outputTab}
                onChange={(value) => setOutputTab(activeTab.id, value)}
              />
              <OutputMeta
                hasAi={Boolean(activeTab.ai)}
                resultsMaximized={resultsMaximized}
                onToggleMaximized={toggleResultsMaximized}
              />
            </div>

            <OutputPane>
              {activeTab.outputTab === 'results' ? (
                activeTab.running && !activeTab.result ? (
                  // First run for the tab: nothing to keep on screen, so the
                  // pane swaps for the running indicator. A re-run over an
                  // existing result keeps the grid mounted below and lets it
                  // show skeleton rows instead of flashing empty.
                  <div className="flex h-full items-center justify-center gap-2 text-xs text-muted">
                    <Spinner size={16} />
                    Running…
                  </div>
                ) : activeTab.result ? (
                  <ResultsGrid
                    result={activeTab.result}
                    pending={activeTab.running}
                    onReveal={revealSensitiveValues}
                  />
                ) : (
                  <EmptyState icon={<Play size={20} />} title="No results yet" />
                )
              ) : null}
              {activeTab.outputTab === 'messages' ? <MessagesPanel tab={activeTab} /> : null}
              {activeTab.outputTab === 'explain' ? (
                <ExplainPanel
                  explain={activeTab.explain}
                  analyzing={analyzing}
                  onAnalyze={() => void explain(true)}
                />
              ) : null}
              {activeTab.outputTab === 'review' ? (
                <ReviewPanel
                  review={activeTab.review}
                  ai={activeTab.ai}
                  aiRaw={activeTab.aiRaw}
                  aiStreaming={activeTab.aiStreaming}
                  aiRunning={activeTab.aiRunning}
                  aiError={activeTab.aiError}
                  providers={providers}
                  defaultProviderId={settings.defaultAiProviderId}
                  onDeepReview={(options) => void deepReview(options)}
                  onCancelAi={cancelAi}
                  onSaveReport={() => void saveReport()}
                  onJumpToLine={jumpToLine}
                  onOpenSql={(text) => {
                    updateSql(activeTab.id, text);
                    toast('Rewrite opened in the editor.', 'info');
                  }}
                  onConfigureAi={() => navigate('/settings?tab=ai')}
                  onRunReview={() => void review()}
                  chatContext={{
                    profileId: activeProfileId,
                    database: selectedDatabase,
                    sql: activeTab.executedSql ?? activeTab.sql,
                  }}
                  chatHistory={{
                    turns: activeTab.reviewChatTurns,
                    onChange: (turns) => patchTab(activeTab.id, { reviewChatTurns: turns }),
                  }}
                />
              ) : null}
            </OutputPane>
          </div>

          <div className="statusbar">
            <span className="flex items-center gap-1">
              <Database size={12} />
              {selectedDatabase ?? 'no database'}
            </span>
            <span>{server?.version ?? 'disconnected'}</span>
            <span className={isAdmin ? 'text-mint' : unlocked ? 'text-warn' : 'text-mint'}>
              {isAdmin ? 'writes enabled' : unlocked ? 'writes unlocked' : 'read-only'}
            </span>
            <span>row cap {settings.rowLimit}</span>
            <span className="ml-auto">
              {activeTab.result
                ? `runtime ${formatDuration(activeTab.result.executionMs)}`
                : 'Ctrl+Enter run · Ctrl+Shift+Enter selection · Ctrl+Shift+R review'}
            </span>
          </div>
        </div>
      </div>

      <UnlockDialog
        open={!isAdmin && unlockOpen}
        classification={unlockClassification}
        sql={pendingText}
        onClose={() => {
          setUnlockOpen(false);
          setUnlockClassification(null);
          setPendingText('');
        }}
        onProceed={() => {
          const text = pendingText;
          setPendingText('');
          setUnlockOpen(false);
          if (text) void execute(text);
        }}
      />

      <AiAssistant
        mode="workspace"
        title="Assistant"
        notice="Full help on the statement in the editor and the schema behind it."
        emptyHint="Ask about the statement in the editor, the schema, or why a query is slow."
        placeholder="Ask about this statement…"
        bottomInset={ASSISTANT_FAB_INSET}
        context={{
          profileId: activeProfileId,
          database: selectedDatabase,
          sql: activeTab.sql,
        }}
        history={{
          turns: activeTab.assistantTurns,
          onChange: (turns) => patchTab(activeTab.id, { assistantTurns: turns }),
        }}
        resetKey={activeTab.id}
        // The proposal is dropped in at the caret (replacing the selection,
        // like the schema and snippet inserts) — it must never wipe the tab.
        onInsertSql={(sql) => insertText(sql)}
      />

      <WorkspaceModals
        historyOpen={historyOpen}
        onCloseHistory={() => setHistoryOpen(false)}
        history={history}
        historyLoading={historyLoading}
        historySearch={historySearch}
        onHistorySearch={setHistorySearch}
        onLoadHistory={loadHistory}
        onClearHistory={() => void clearHistory()}
        snippetsOpen={snippetsOpen}
        onCloseSnippets={() => setSnippetsOpen(false)}
        snippets={snippets}
        snippetsLoading={snippetsLoading}
        snippetTitle={snippetTitle}
        onSnippetTitle={setSnippetTitle}
        snippetTags={snippetTags}
        onSnippetTags={setSnippetTags}
        snippetBusy={snippetBusy}
        onSaveSnippet={() => void saveSnippet()}
        onInsertSnippet={(text) => {
          insertText(text);
          setSnippetsOpen(false);
        }}
        onDeleteSnippet={(id) => void deleteSnippet(id)}
      />
    </>
  );
}
