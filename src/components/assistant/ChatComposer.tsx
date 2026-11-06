import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import { Send, Square } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The imperative handle the host uses to move focus into the composer. */
export interface ComposerHandle {
  focus: () => void;
}

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  /** Renders the whole composer unusable (no provider configured). */
  disabled?: boolean;
  placeholder: string;
  /** The line count the field grows to before it scrolls. */
  maxRows?: number;
  className?: string;
}

/** Matches the field's line-height in assistant.css; the +16 covers padding. */
const LINE_HEIGHT = 22;

/**
 * The composer of an assistant surface, ported from the SeaSID agent.
 *
 * - The field grows with its content up to `maxRows` lines, then scrolls.
 * - `Enter` sends; `Shift+Enter` falls through to a newline.
 * - While a turn streams, the send button is replaced by a stop button and
 *   the field is disabled, so the only way forward is through or stop.
 * - The imperative `focus()` handles the busy case by retrying on the next
 *   microtask, when React has flipped the disabled flag back off.
 */
export const ChatComposer = forwardRef<ComposerHandle, ChatComposerProps>(function ChatComposer(
  { value, onChange, onSend, onStop, busy, disabled = false, placeholder, maxRows = 6, className },
  ref,
) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = value.trim().length > 0 && !busy && !disabled;

  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = LINE_HEIGHT * maxRows + 16;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, maxRows]);

  // The caret stays at the end when the host swaps the value programmatically.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el || document.activeElement !== el) return;
    const length = el.value.length;
    if (el.selectionStart !== length) el.setSelectionRange(length, length);
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const el = fieldRef.current;
        if (!el) return;
        if (el.disabled) {
          // Busy: try again on the next microtask, when React has flipped the
          // disabled flag back off.
          queueMicrotask(() => {
            const inner = fieldRef.current;
            if (inner && !inner.disabled) {
              inner.focus();
              const length = inner.value.length;
              inner.setSelectionRange(length, length);
            }
          });
          return;
        }
        el.focus();
        const length = el.value.length;
        el.setSelectionRange(length, length);
      },
    }),
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className={cn('ai-composer', busy && 'ai-composer-busy', className)}>
      <textarea
        ref={fieldRef}
        className="ai-composer-field"
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={disabled || busy}
        aria-label={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <button
          type="button"
          className="ai-composer-stop"
          onClick={onStop}
          aria-label="Stop generating"
          data-testid="composer-stop"
        >
          <Square size={12} className="fill-current" />
        </button>
      ) : (
        <button
          type="button"
          className="ai-composer-send"
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send message"
          data-testid="composer-send"
        >
          <Send size={13} />
        </button>
      )}
    </div>
  );
});
