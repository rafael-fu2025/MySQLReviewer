import { describe, expect, it } from 'vitest';
import {
  feedThinking,
  flushThinking,
  makeThinkSplitter,
  stripThinkBlocks,
} from '../server/ai/thinking';

/**
 * Reasoning models stream `<think>` tags inline in the text deltas, and a tag
 * can land across two chunks. The splitter must never leak half a tag into
 * the answer and never lose a tail that ends mid-tag.
 */
describe('think splitter', () => {
  it('routes a whole think block to the thinking lane', () => {
    const state = makeThinkSplitter();
    const split = feedThinking(state, '<think>plan it</think>The answer.');
    expect(split).toEqual({ visible: 'The answer.', thinking: 'plan it' });
    expect(flushThinking(state)).toEqual({ visible: '', thinking: '' });
  });

  it('reassembles a tag that is fragmented across deltas', () => {
    const state = makeThinkSplitter();
    const first = feedThinking(state, 'Answer soon. <thi');
    const second = feedThinking(state, 'nk>deep thought</th');
    const third = feedThinking(state, 'ink>Here it is.');
    expect(first.visible).toBe('Answer soon. ');
    expect(first.thinking).toBe('');
    expect(second.thinking).toBe('deep thought');
    expect(second.visible).toBe('');
    expect(third).toEqual({ visible: 'Here it is.', thinking: '' });
  });

  it('passes plain text through untouched', () => {
    const state = makeThinkSplitter();
    expect(feedThinking(state, 'no tags here')).toEqual({
      visible: 'no tags here',
      thinking: '',
    });
  });

  it('holds back a tail that could still open a think block', () => {
    const state = makeThinkSplitter();
    const split = feedThinking(state, 'text <');
    expect(split.visible).toBe('text ');
    expect(state.buffer).toBe('<');
    // The next delta closes the held-back tag.
    const rest = feedThinking(state, 'think>secret</think>done');
    expect(rest.thinking).toBe('secret');
    expect(rest.visible).toBe('done');
  });

  it('drops a stray closing tag outside any think block', () => {
    const state = makeThinkSplitter();
    const split = feedThinking(state, 'a</think>b');
    expect(split).toEqual({ visible: 'ab', thinking: '' });
  });

  it('sends an unclosed think tail to the thinking lane, not the answer', () => {
    const state = makeThinkSplitter();
    const split = feedThinking(state, '<think>never closed');
    // The reasoning inside the unclosed block is already on the thinking lane.
    expect(split).toEqual({ visible: '', thinking: 'never closed' });
    expect(flushThinking(state)).toEqual({ visible: '', thinking: '' });
  });

  it('sends a held-back plain tail to the visible lane on flush', () => {
    const state = makeThinkSplitter();
    feedThinking(state, 'ends with <');
    const flush = flushThinking(state);
    expect(flush).toEqual({ visible: '<', thinking: '' });
  });

  describe('stripThinkBlocks', () => {
    it('removes closed and unclosed blocks and stray tags', () => {
      expect(stripThinkBlocks('<think>a</think>answer')).toBe('answer');
      expect(stripThinkBlocks('answer<think>a')).toBe('answer');
      expect(stripThinkBlocks('a</think>b')).toBe('ab');
      expect(stripThinkBlocks('<think>x</think>a<think>y</think>b')).toBe('ab');
    });
  });
});
