import { describe, expect, it } from 'vitest';
import { nextPaletteIndex } from '../src/lib/keyboard';

/**
 * The command palette used to stop the arrows at the ends of the list and
 * ignore Home/End/PageUp/PageDown entirely, and the highlighted option was
 * never scrolled into view. The moves now live in one helper so the wrap
 * around, the jumps, and the page step are pinned down here.
 */
describe('command palette keyboard navigation', () => {
  it('wraps the arrows around the ends of the list', () => {
    expect(nextPaletteIndex('ArrowDown', 0, 5)).toBe(1);
    expect(nextPaletteIndex('ArrowDown', 4, 5)).toBe(0);
    expect(nextPaletteIndex('ArrowUp', 2, 5)).toBe(1);
    expect(nextPaletteIndex('ArrowUp', 0, 5)).toBe(4);
  });

  it('jumps to the first and last item with Home and End', () => {
    expect(nextPaletteIndex('Home', 3, 5)).toBe(0);
    expect(nextPaletteIndex('End', 0, 5)).toBe(4);
  });

  it('steps a page with PageUp and PageDown, clamped to the ends', () => {
    expect(nextPaletteIndex('PageDown', 0, 25)).toBe(10);
    expect(nextPaletteIndex('PageDown', 20, 25)).toBe(24);
    expect(nextPaletteIndex('PageUp', 24, 25)).toBe(14);
    expect(nextPaletteIndex('PageUp', 3, 25)).toBe(0);
  });

  it('leaves an empty list and unhandled keys alone', () => {
    expect(nextPaletteIndex('ArrowDown', 0, 0)).toBeNull();
    expect(nextPaletteIndex('Enter', 2, 5)).toBeNull();
    expect(nextPaletteIndex('Home', 2, 0)).toBeNull();
  });
});
