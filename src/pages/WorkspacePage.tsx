import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EditorView } from '@codemirror/view';
import { format as formatSql } from 'sql-formatter';
import {
  Bookmark,
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
 * The height of the status bar along the bottom of the workspace, in pixels
 * (`.statusbar` in styles/features/editor.css). The floating assistant button
 * is lifted by this much, so it never sits on top of the bar.
 */
const STATUS_BAR_HEIGHT = 26;

/**
 * The height of the floating assistant button, in pixels (`.ai-fab` in
 * styles/features/assistant.css), and the gap it keeps from the content it
 * floats over.
 */
const ASSISTANT_BUTTON_HEIGHT = 50;
const ASSISTANT_CLEARANCE = 12;

/**
 * The space the output pane leaves for the floating assistant button.
 *
 * The button rests `--ai-fab-bottom` above the window edge and is lifted by
 * the height of the status bar — which is exactly how far the bottom of the
 * pane sits above the window edge — so it ends up `--ai-fab-bottom` plus its
 * own height above the last row. The band follows the same variable, so the
 * phone layout, which raises the button above the bottom navigation,
 * reserves the room it needs as well.
 */
const ASSISTANT_RESERVED = `calc(var(--ai-fab-bottom) + ${
  ASSISTANT_BUTTON_HEIGHT + ASSISTANT_CLEARANCE
}px)`;

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

      {!tab.error && !result ? <EmptyState icon={<Info size={22} />} title="No messages" /> : null}
    </div>
  );
}

/**
 * The right-hand end of the output strip: the result badges and the control
 * that swaps between the editor and the results.
 *
 * The row count and the duration are not repeated here — the grid below
 * carries them, and the status bar carries the runtime.
 */
export function OutputMeta({
  score,
  hasAi,
  resultsMaximized,
  onToggleMaximized,
}: {
  score: number | null;
  hasAi: boolean;
  resultsMaximized: boolean;
  onToggleMaximized: () => void;
}) {
  return (
    <div className="ml-auto flex items-center gap-2 px-3 text-2xs text-muted">
      {score != null ? <Badge tone="neutral">score {score}</Badge> : null}
      {hasAi ? <Badge tone="info">AI</Badge> : null}
      <Button
        variant="ghost"
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
 * The band at the bottom is reserved for the floating assistant button, so
 * the button never covers the last row.
 */
export function OutputPane({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto" style={{ paddingBottom: ASSISTANT_RESERVED }}>
      {children}
    </div>
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
  const [snippetTitle, setSnippetTitle] = useState('');
  const [snippetTags, setSnippetTags] = useState('');
  const [snippetBusy, setSnippetBusy] = useState(false);

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
    const current = activeTab.sql;
    try {
      const formatted = formatSql(current, {
        language: 'mysql',
        keywordCase: 'upper',
        tabWidth: 2,
        linesBetweenQueries: 2,
      });
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
    try {
      setSnippets(await dbApi.snippets());
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
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
    const rect = area.getBoundingClientRect();
    splitterDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startPct: editorPct,
      areaHeight: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  };

  const splitterPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = splitterDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaPct = ((event.clientY - drag.startY) / drag.areaHeight) * 100;
    setEditorPct(Math.max(SPLITTER_MIN, Math.min(SPLITTER_MAX, drag.startPct + deltaPct)));
  };

  const splitterPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = splitterDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    splitterDragRef.current = null;
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') {
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
                  <X size={10} />
                </button>
              </div>
            ))}
            <IconButton label="New statement tab" onClick={() => createTab()}>
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
            <Button variant="ghost" size="sm" icon={<Wand2 size={12} />} onClick={formatCurrent}>
              Format
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Bookmark size={12} />}
              onClick={() => void openSnippets()}
            >
              Snippets
            </Button>
            <Button
              variant="ghost"
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
                    variant="danger"
                    size="sm"
                    icon={<Lock size={11} />}
                    onClick={() => void lockWrites()}
                  >
                    Lock writes
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
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

          <div className="editor-wrap" style={{ height: `${editorPct}%` }}>
            <SqlEditor
              value={editorValue}
              onChange={(value) => updateSql(activeTab.id, value)}
              schema={schema}
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
            aria-valuenow={Math.round(editorPct)}
            aria-valuemin={SPLITTER_MIN}
            aria-valuemax={SPLITTER_MAX}
            aria-valuetext={`${Math.round(editorPct)}% editor height`}
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
                score={activeTab.review ? activeTab.review.score.score : null}
                hasAi={Boolean(activeTab.ai)}
                resultsMaximized={resultsMaximized}
                onToggleMaximized={toggleResultsMaximized}
              />
            </div>

            <OutputPane>
              {activeTab.outputTab === 'results' ? (
                activeTab.running ? (
                  <div className="flex h-full items-center justify-center gap-2 text-xs text-muted">
                    <Spinner size={16} />
                    Running…
                  </div>
                ) : activeTab.result ? (
                  <ResultsGrid result={activeTab.result} onReveal={revealSensitiveValues} />
                ) : (
                  <EmptyState icon={<Play size={22} />} title="No results yet" />
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
              <Database size={10} />
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
        bottomInset={STATUS_BAR_HEIGHT}
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
        onInsertSql={(sql) => updateSql(activeTab.id, sql)}
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
