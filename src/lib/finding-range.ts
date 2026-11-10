/**
 * The editor range one lint finding highlights.
 *
 * Token rules report a 1-based character column, so the mark narrows to that
 * token when its extent is visible on the line (a punctuation token gets its
 * single character). Findings without a column keep the whole line, and an
 * empty line collapses to a zero-width point — which CodeMirror renders as a
 * point mark — instead of `from + 1` bleeding into the next line's first
 * character.
 */
export function findingRange(
  column: number | null | undefined,
  line: { from: number; to: number },
  lineText: string,
): { from: number; to: number } {
  if (typeof column === 'number' && column >= 1 && column <= lineText.length) {
    const token = /^[A-Za-z0-9_$]+/.exec(lineText.slice(column - 1));
    const from = line.from + column - 1;
    return { from, to: Math.min(line.to, from + (token ? token[0].length : 1)) };
  }
  return { from: line.from, to: line.to };
}
