/**
 * A route change must start the new page at the top.
 *
 * The app shell keeps the page body in its own scroll container, so a new
 * page otherwise opens at the scroll offset of the page you came from, with
 * its heading already above the fold.
 */
export function resetScrollTop(node: { scrollTop: number } | null | undefined): void {
  if (node) node.scrollTop = 0;
}
