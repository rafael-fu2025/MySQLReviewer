import type { AiChatMessage } from '@shared/types';
import { Markdown } from '@/components/Markdown';
import { Spinner } from '@/components/ui';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallList } from './ToolCallList';

/**
 * One turn of the transcript, decomposed the way the SeaSID agent structures
 * its messages: a dispatcher over role, with a dedicated assistant message
 * that orders tool calls → thinking → answer.
 *
 * Errors are not a message role here — a failed turn surfaces through the
 * panel-level callout, so there is no ErrorMessage branch.
 */
export interface MessageProps {
  message: AiChatMessage;
  /** The name shown above an assistant reply. */
  assistantLabel: string;
  /** True for the in-flight draft turn. */
  streaming?: boolean;
  onInsertSql?: (sql: string) => void;
}

export function Message({ message, assistantLabel, streaming = false, onInsertSql }: MessageProps) {
  if (message.role === 'user') return <UserMessage message={message} />;
  return (
    <AssistantMessage
      message={message}
      assistantLabel={assistantLabel}
      streaming={streaming}
      onInsertSql={onInsertSql}
    />
  );
}

function UserMessage({ message }: { message: AiChatMessage }) {
  return (
    <div className="ai-bubble ai-bubble-user" data-testid="message-user">
      <div className="mono-label mb-1">you</div>
      <div className="whitespace-pre-wrap text-xs text-ink-soft">{message.content}</div>
    </div>
  );
}

function AssistantMessage({
  message,
  assistantLabel,
  streaming,
  onInsertSql,
}: {
  message: AiChatMessage;
  assistantLabel: string;
  streaming: boolean;
  onInsertSql?: (sql: string) => void;
}) {
  const toolCount = message.toolCalls?.length ?? 0;
  const hasContent = Boolean(message.content.trim());
  const hasThinking = Boolean(message.thinking?.trim());

  // While nothing has arrived yet, the thinking row owns the wait indicator —
  // a bubble with only a spinner would duplicate it.
  if (streaming && !hasContent && !hasThinking && toolCount === 0) return null;

  return (
    <div
      className="ai-bubble ai-bubble-assistant"
      data-testid="message-assistant"
      data-streaming={streaming || undefined}
    >
      <div className="mono-label mb-1 flex items-center gap-2">
        {assistantLabel}
        {streaming ? <Spinner size={10} /> : null}
        {toolCount > 0 ? (
          <span className="ai-tool-count">
            · {toolCount} tool{toolCount === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
      <ToolCallList calls={message.toolCalls ?? []} onInsertSql={onInsertSql} />
      <ThinkingBlock text={message.thinking ?? ''} streaming={streaming} />
      {hasContent ? (
        <Markdown sanitize codeCopy>
          {message.content}
        </Markdown>
      ) : null}
      {message.usage ? (
        <div className="ai-usage">
          ↑{formatTokens(message.usage.inputTokens)} ↓{formatTokens(message.usage.outputTokens)}{' '}
          tokens
        </div>
      ) : null}
    </div>
  );
}

/** Token counts render compactly; absent counts render as a dash. */
function formatTokens(count: number | null | undefined): string {
  if (count == null) return '—';
  return count.toLocaleString();
}
