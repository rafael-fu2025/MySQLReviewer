import { describe, expect, it } from 'vitest';
import { resetScrollTop } from '../src/lib/scroll';

/**
 * D-06 — the scroll position was not reset on a route change.
 *
 * Leaving a page scrolled down and opening another one kept the offset, so
 * the new page's heading sat above the fold. Measured in the browser: the
 * Settings page was 92px down, and the Admin page opened at the same 92px.
 *
 * The shell has two scroll containers - the page body (`.content`) and the
 * frame (`main`) - and both are reset, because either one can carry the
 * offset over to the next route.
 */
describe('resetScrollTop', () => {
  it('puts a scrolled container back at the top', () => {
    const node = { scrollTop: 92 };
    resetScrollTop(node);
    expect(node.scrollTop).toBe(0);
  });

  it('leaves a container that is already at the top alone', () => {
    const node = { scrollTop: 0 };
    resetScrollTop(node);
    expect(node.scrollTop).toBe(0);
  });

  it('does nothing when there is no container', () => {
    expect(() => resetScrollTop(null)).not.toThrow();
    expect(() => resetScrollTop(undefined)).not.toThrow();
  });
});
