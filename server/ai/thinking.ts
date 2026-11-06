/**
 * Splits inline reasoning out of a provider text stream.
 *
 * Reasoning models served through OpenAI-compatible endpoints (DeepSeek,
 * MiniMax, Qwen and friends) stream their reasoning inline as
 * `<think>…</think>` inside the text deltas. A naive per-delta split would
 * leak half a tag into the answer when a tag lands across two chunks, so the
 * splitter holds back a tail just short of a possible tag boundary — the same
 * state machine the SeaSID reference client uses, moved server-side so every
 * surface (and the challenge screen) sees clean text.
 */

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

export interface ThinkSplitterState {
  inThink: boolean;
  /** Text held back because it may still grow into a tag boundary. */
  buffer: string;
}

export interface ThinkSplit {
  /** Answer text for the visible lane. */
  visible: string;
  /** Reasoning text for the thinking lane. */
  thinking: string;
}

export function makeThinkSplitter(): ThinkSplitterState {
  return { inThink: false, buffer: '' };
}

/**
 * The longest suffix of `text` that is a proper prefix of `tag`.
 *
 * A chunk ending in `<thi` must not be emitted yet: the next chunk may turn
 * it into `<think>`. Anything shorter than a full tag can be recognized this
 * way, so the hold-back never exceeds `tag.length - 1` characters.
 */
function holdBack(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

export function feedThinking(state: ThinkSplitterState, delta: string): ThinkSplit {
  const visible: string[] = [];
  const thinking: string[] = [];
  let pending = state.buffer + delta;
  state.buffer = '';

  while (pending) {
    if (state.inThink) {
      const close = pending.indexOf(THINK_CLOSE);
      if (close >= 0) {
        thinking.push(pending.slice(0, close));
        pending = pending.slice(close + THINK_CLOSE.length);
        state.inThink = false;
        continue;
      }
      const hold = holdBack(pending, THINK_CLOSE);
      if (hold > 0) {
        thinking.push(pending.slice(0, pending.length - hold));
        state.buffer = pending.slice(pending.length - hold);
      } else {
        thinking.push(pending);
      }
      pending = '';
    } else {
      const open = pending.indexOf(THINK_OPEN);
      const close = pending.indexOf(THINK_CLOSE);
      // A stray closing tag with no open tag is model noise; drop it.
      if (close >= 0 && (open < 0 || close < open)) {
        visible.push(pending.slice(0, close));
        pending = pending.slice(close + THINK_CLOSE.length);
        continue;
      }
      if (open >= 0) {
        visible.push(pending.slice(0, open));
        pending = pending.slice(open + THINK_OPEN.length);
        state.inThink = true;
        continue;
      }
      const hold = holdBack(pending, THINK_OPEN);
      if (hold > 0) {
        visible.push(pending.slice(0, pending.length - hold));
        state.buffer = pending.slice(pending.length - hold);
      } else {
        visible.push(pending);
      }
      pending = '';
    }
  }

  return { visible: visible.join(''), thinking: thinking.join('') };
}

/**
 * Emits the hold-back tail once the stream has ended. A stream that stopped
 * mid-think sends its tail to the thinking lane, not to the answer.
 */
export function flushThinking(state: ThinkSplitterState): ThinkSplit {
  const tail = state.buffer;
  state.buffer = '';
  if (!tail) return { visible: '', thinking: '' };
  return state.inThink ? { visible: '', thinking: tail } : { visible: tail, thinking: '' };
}

/**
 * Removes every `<think>` block from a finished text, including one that was
 * left unclosed by a truncated answer, and any stray closing tags.
 */
export function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/<\/think>/g, '');
}
