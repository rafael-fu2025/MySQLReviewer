import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { Sparkles, Trash2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AgentThinking } from './AgentThinking';
import { ChatComposer, type ComposerHandle } from './ChatComposer';
import { Message } from './Message';
import type { AssistantDraft, ChatTurn } from './useAssistantChat';

export interface ChatPanelProps {
  messages: ChatTurn[];
  /** The answer that is still arriving: content, thinking and tool calls. */
  draft: AssistantDraft;
  streaming: boolean;
  error: string | null;
  /** The name shown above an assistant reply. */
  assistantLabel: string;
  /** The copy shown while the transcript is empty. */
  emptyHint: string;
  /** Tools the agent may use in this context; advertised in the empty state. */
  toolCount?: number;
  placeholder: string;
  input: string;
  /** Renders the panel unusable (no provider configured). */
  disabled?: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /**
   * Clears the transcript. Only hosts without their own panel header render
   * the inline clear button (the review follow-up card); the FAB panel puts
   * reset in its header instead.
   */
  onClear?: () => void;
  /**
   * Inserts a proposed statement into the host editor. When the host has no
   * editor (the review follow-up chat), proposal cards show Copy only.
   */
  onInsertSql?: (sql: string) => void;
  /** A notice above the transcript, e.g. the mode of the assistant. */
  notice?: ReactNode;
  /** The composer field, so the host can move focus into it. */
  composerRef?: Ref<ComposerHandle>;
  className?: string;
}

/**
 * How far from the bottom the transcript has to be before it stops following
 * the stream. A reader who has scrolled up to re-read something must not be
 * dragged back down by the next token.
 */
const FOLLOW_THRESHOLD_PX = 80;

/**
 * The transcript and the composer of an assistant surface.
 *
 * Accessibility notes:
 *
 * - The transcript is a `log`, so a finished reply is announced once. The
 *   tokens that are still streaming are kept out of the live region: a
 *   screen reader would otherwise read the answer out one word at a time.
 * - The streaming state is announced once through a `status` region instead.
 */
export function ChatPanel({
  messages,
  draft,
  streaming,
  error,
  assistantLabel,
  emptyHint,
  toolCount,
  placeholder,
  input,
  disabled,
  onInputChange,
  onSend,
  onStop,
  onClear,
  onInsertSql,
  notice,
  composerRef,
  className,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const handleScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, draft]);

  // While nothing has arrived yet, the thinking row owns the wait.
  const waiting =
    streaming && !draft.content.trim() && !draft.thinking.trim() && draft.toolCalls.length === 0;

  // One announcement per step instead of one per token.
  const runningTool = draft.toolCalls.find((call) => call.status === 'running');

  return (
    <div className={cn('ai-chat', className)}>
      {notice ? <div className="ai-chat-notice">{notice}</div> : null}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="ai-chat-log"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        {messages.length === 0 && !streaming ? (
          <div className="ai-chat-empty" data-testid="chat-empty">
            <div className="ai-empty-icon" aria-hidden="true">
              <Sparkles size={16} />
            </div>
            <div className="ai-empty-title">No conversation yet</div>
            <div className="ai-empty-hint">{emptyHint}</div>
            {toolCount ? (
              <div className="ai-empty-tools">
                The agent can run {toolCount} tool{toolCount === 1 ? '' : 's'} in this context.
              </div>
            ) : null}
          </div>
        ) : null}

        {messages.map((message, index) => (
          <Message
            key={`${message.role}-${index}`}
            message={message}
            assistantLabel={assistantLabel}
            onInsertSql={onInsertSql}
          />
        ))}

        {waiting ? <AgentThinking /> : null}

        {!waiting && streaming ? (
          <Message
            message={{
              role: 'assistant',
              content: draft.content,
              thinking: draft.thinking,
              toolCalls: draft.toolCalls,
            }}
            assistantLabel={assistantLabel}
            streaming
            onInsertSql={onInsertSql}
          />
        ) : null}
      </div>

      {/* One announcement per answer or tool step instead of one per token. */}
      <div role="status" className="sr-only">
        {runningTool ? `Running ${runningTool.name}` : streaming ? 'Generating a response' : ''}
      </div>

      {error ? (
        <div className="callout danger mt-2 flex items-start gap-2">
          <XCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="ai-composer-row">
        <ChatComposer
          ref={composerRef}
          value={input}
          onChange={onInputChange}
          onSend={onSend}
          onStop={onStop}
          busy={streaming}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1"
        />
        {onClear && messages.length > 0 ? (
          <button
            type="button"
            className="ai-panel-icon-btn ai-composer-clear"
            onClick={onClear}
            aria-label="Clear the conversation"
            title="Clear"
          >
            <Trash2 size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
