/** How far one PageUp/PageDown moves in a flat option list. */
const PAGE_STEP = 10;

/**
 * The next highlighted index for a keyboard move over `count` items.
 *
 * The arrows wrap around the ends (down from the last item lands on the
 * first, up from the first on the last), Home/End jump straight there, and
 * PageUp/PageDown step a larger chunk with the ends clamped. Any other key —
 * or an empty list — returns `null`, leaving the key to its default behavior.
 */
export function nextPaletteIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageUp':
      return Math.max(0, index - PAGE_STEP);
    case 'PageDown':
      return Math.min(count - 1, index + PAGE_STEP);
    default:
      return null;
  }
}
