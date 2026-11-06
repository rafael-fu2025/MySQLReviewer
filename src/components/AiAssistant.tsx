import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Sparkles, X } from 'lucide-react';
import type { AssistantMode } from '@shared/types';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/app-store';
import { ConfirmDialog } from '@/components/ui';
import { ChatPanel } from './assistant/ChatPanel';
import type { ComposerHandle } from './assistant/ChatComposer';
import { useAssistantChat, type ChatTurn } from './assistant/useAssistantChat';

export interface AiAssistantHistory {
  /** The transcript of the current context. */
  turns: ChatTurn[];
  /** Called whenever the transcript changes. */
  onChange: (turns: ChatTurn[]) => void;
}

export interface AiAssistantProps {
  mode: AssistantMode;
  /** The heading of the panel. */
  title: string;
  /** A one-line note about what this assistant may and may not do. */
  notice: string;
  /** The copy shown while the transcript is empty. */
  emptyHint: string;
  placeholder: string;
  /** The state of the screen the assistant belongs to. */
  context: {
    profileId: string | null;
    database: string | null;
    /** The statement in the editor. Workspace mode only. */
    sql?: string;
    /** The open practice challenge. Challenge mode only. */
    question?: { setId: string; questionId: string } | null;
  };
  /**
   * The transcript of the current context, when the host keeps one.
   *
   * A host that owns the transcript can hold a separate conversation per
   * query tab or per challenge, so moving to another one and coming back
   * does not throw the conversation away.
   */
  history?: AiAssistantHistory;
  /**
   * Changing this value starts a fresh conversation. The practice lab uses
   * the question id, so the tutor never carries the previous challenge's
   * context into the next one.
   */
  resetKey?: string;
  /**
   * Inserts a proposed statement into the host editor. When omitted,
   * proposal cards degrade to Copy-only.
   */
  onInsertSql?: (sql: string) => void;
  /**
   * The height of a bar along the bottom of the host, in pixels — a status
   * bar, for example. The button is lifted by that much, so it never sits on
   * top of the bar or on the content behind it.
   */
  bottomInset?: number;
}

/**
 * The gap the panel keeps above the button, in pixels. It mirrors the offset
 * of `.ai-panel` in styles/features/assistant.css.
 */
const PANEL_GAP = 60;

/**
 * The assistant that lives in the floating action button.
 *
 * It is a non-modal panel: the page behind it stays usable, so focus is not
 * trapped and `aria-modal` is deliberately absent (the ARIA patterns warn
 * against marking a non-modal panel as modal). Escape closes the panel and
 * returns the focus to the button that opened it.
 */
export function AiAssistant({
  mode,
  title,
  notice,
  emptyHint,
  placeholder,
  context,
  history,
  resetKey,
  onInsertSql,
  bottomInset = 0,
}: AiAssistantProps) {
  const providers = useAppStore((state) => state.providers);
  const settings = useAppStore((state) => state.settings);
  const currentUser = useAppStore((state) => state.currentUser);

  const provider = useMemo(
    () =>
      providers.find((item) => item.id === settings.defaultAiProviderId) ??
      providers.find((item) => item.isDefault) ??
      providers[0] ??
      null,
    [providers, settings.defaultAiProviderId],
  );

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ComposerHandle | null>(null);

  const { profileId, database, sql, question } = context;

  const buildRequest = useCallback(
    (turns: ChatTurn[]): Record<string, unknown> => ({
      mode,
      providerId: provider?.id ?? '',
      model: provider?.model,
      messages: turns,
      context: {
        profileId,
        database,
        ...(mode === 'workspace' ? { sql: sql ?? '' } : {}),
        ...(mode === 'challenge' ? { question } : {}),
      },
    }),
    [mode, provider?.id, provider?.model, profileId, database, sql, question],
  );

  const chat = useAssistantChat({
    buildRequest,
    messages: history?.turns,
    onMessagesChange: history?.onChange,
  });

  /**
   * Silent restore. The conversation id is derived from the context key, so
   * it is stable across refreshes without storing anything client-side. On
   * the first sight of an empty host-owned transcript, the saved turns are
   * fetched and adopted; a fresh context simply 404s and stays empty.
   */
  const conversationId = useMemo(() => (resetKey ? `ctx-${resetKey}` : null), [resetKey]);
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const restoredRef = useRef<string | null>(null);
  // The turn list produced by a restore must not be saved straight back.
  const skipSaveRef = useRef(false);

  useEffect(() => {
    if (!conversationId) return;
    if (restoredRef.current === conversationId) return;
    const host = historyRef.current;
    if (!host) return;
    restoredRef.current = conversationId;
    if (host.turns.length) return;
    let cancelled = false;
    // `api.get` resolves the unwrapped `data` payload, so the turns sit on the
    // result itself; reading `result.data.turns` adopted nothing and the panel
    // came back empty after every refresh.
    void api
      .get<{ turns: ChatTurn[] }>(`/api/ai/conversations/${conversationId}`)
      .then((result) => {
        const turns = result?.turns;
        if (cancelled || !turns?.length) return;
        skipSaveRef.current = true;
        historyRef.current?.onChange(turns);
      })
      .catch(() => undefined); // Nothing saved yet: a fresh context.
    return () => {
      cancelled = true;
    };
    // Only the context identity belongs here. The host builds its history
    // object afresh on every render, so depending on it would run the cleanup
    // on the next render and cancel the fetch it had just started — while the
    // guard above refuses to start a second one, leaving the thread lost.
  }, [conversationId]);

  // Persist after each finished turn, debounced so a restore echo and its
  // follow-up renders collapse into one write.
  const turnsForSave = history?.turns;
  useEffect(() => {
    if (!conversationId || !turnsForSave) return;
    const turns = turnsForSave;
    if (turns.length === 0 || turns[turns.length - 1].role !== 'assistant') return;
    if (chat.streaming) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    const body = {
      mode,
      profileId,
      turns: turns.map((turn) => ({
        role: turn.role,
        content: turn.content.slice(0, 8_000),
        ...(turn.thinking ? { thinking: turn.thinking.slice(0, 32_000) } : {}),
        ...(turn.toolCalls?.length ? { toolCalls: turn.toolCalls } : {}),
        ...(turn.usage ? { usage: turn.usage } : {}),
      })),
    };
    const timer = window.setTimeout(() => {
      void api.put(`/api/ai/conversations/${conversationId}`, body).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
    // The transcript array is the dependency, not the host's history object:
    // that object is rebuilt on every render of the host, so depending on it
    // would re-arm a full-transcript write after any unrelated interaction —
    // a keystroke in the editor, a results refresh, an output tab switch.
  }, [conversationId, turnsForSave, chat.streaming, mode, profileId, history]);

  const clearConversation = useCallback((): void => {
    chat.clear();
    if (conversationId) {
      void api.del(`/api/ai/conversations/${conversationId}`).catch(() => undefined);
    }
    // The chat object is fresh per render; clear is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.clear, conversationId]);

  // SeaSID's reset pattern: an empty transcript clears without ceremony; a
  // non-empty one asks first, because a discarded thread cannot be recovered
  // from the panel (only by reopening the context).
  const hasMessages = chat.messages.length > 0;
  const requestReset = useCallback((): void => {
    if (hasMessages) {
      setResetDialogOpen(true);
      return;
    }
    clearConversation();
  }, [clearConversation, hasMessages]);

  const confirmReset = useCallback((): void => {
    setResetDialogOpen(false);
    clearConversation();
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [clearConversation]);

  // A different context must not carry an answer that is still on its way.
  // The conversation itself belongs to the context: when the host keeps a
  // transcript per context, that transcript is the one that stays.
  useEffect(() => {
    if (history) chat.abandon();
    else chat.clear();
    // The chat object is a new one on every render; the reset is keyed to
    // the reset key alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const close = useCallback((): void => {
    setOpen(false);
    // The focus goes back where it came from, so a keyboard user is never
    // dropped at the top of the document.
    fabRef.current?.focus();
  }, []);

  const toggle = useCallback((): void => {
    setOpen((value) => !value);
  }, []);

  // Focus moves into the composer when the panel opens, and returns to it
  // when a stream ends — the composer is the continuation point either way.
  useEffect(() => {
    if (!open) return;
    if (chat.streaming) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, chat.streaming]);

  // Escape closes the panel from anywhere inside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, open]);

  // A click outside the panel dismisses it, the way a floating widget is
  // expected to behave.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (fabRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const send = useCallback((): void => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    chat.send(text);
  }, [chat, input]);

  const noProvider = providers.length === 0;
  const panelId = 'mylens-ai-assistant-panel';

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className="ai-fab"
        style={{ bottom: `calc(var(--ai-fab-bottom) + ${bottomInset}px)` }}
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={open ? 'Close the assistant' : 'Open the assistant'}
        title={open ? 'Close the assistant' : title}
      >
        {open ? <X size={19} /> : <Sparkles size={19} />}
      </button>

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          className="ai-panel"
          style={{ bottom: `calc(var(--ai-fab-bottom) + ${PANEL_GAP + bottomInset}px)` }}
          role="dialog"
          aria-label={title}
        >
          <div className="ai-panel-head">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-xs font-bold">{title}</span>
                {chat.meta?.agent ? <span className="ai-agent-chip">agent</span> : null}
              </div>
              <div className="truncate font-mono text-micro text-muted">
                {provider ? `${provider.name} · ${provider.model}` : 'no provider'}
              </div>
            </div>
            <div className="ai-panel-head-actions">
              <button
                type="button"
                className="ai-panel-icon-btn"
                onClick={requestReset}
                disabled={!hasMessages}
                aria-label={hasMessages ? 'Reset the conversation' : 'Nothing to reset'}
                title={hasMessages ? 'Reset conversation' : 'Nothing to reset'}
              >
                <RotateCcw size={13} />
              </button>
              <button
                type="button"
                className="ai-panel-icon-btn"
                onClick={close}
                aria-label="Close the assistant"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {noProvider ? (
            <div className="ai-panel-body">
              <div className="callout info flex items-start gap-2">
                <Sparkles size={14} className="mt-0.5 shrink-0" />
                <span>
                  {currentUser?.role === 'admin'
                    ? 'Add an AI provider in Settings to use the assistant.'
                    : 'No AI provider is configured. Ask an administrator to add one.'}
                </span>
              </div>
            </div>
          ) : (
            <ChatPanel
              messages={chat.messages}
              draft={chat.draft}
              streaming={chat.streaming}
              error={chat.error}
              assistantLabel={provider?.name ?? 'assistant'}
              emptyHint={emptyHint}
              toolCount={chat.meta?.agent ? (chat.meta.tools?.length ?? 0) : undefined}
              placeholder={placeholder}
              input={input}
              composerRef={composerRef}
              notice={<span>{notice}</span>}
              onInputChange={setInput}
              onSend={send}
              onStop={chat.stop}
              onInsertSql={onInsertSql}
              className="ai-panel-body"
            />
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={resetDialogOpen}
        onClose={() => setResetDialogOpen(false)}
        onConfirm={confirmReset}
        title="Discard this conversation?"
        message="This clears every message in this thread. It cannot be undone."
        confirmLabel="Discard"
        danger
      />
    </>
  );
}
