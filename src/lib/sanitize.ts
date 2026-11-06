/**
 * Model output hygiene, ported from the SeaSID renderer: emoji pictographs
 * are stripped, and any `<think>` markup that survives the server-side
 * splitter (mixed providers, cached transcripts) is removed before it can
 * render as text.
 *
 * Lives outside the component file so `Markdown.tsx` only exports a component
 * and React Fast Refresh keeps working across edits.
 */
const PICTOGRAPH_RE = /\p{Extended_Pictographic}/gu;
const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
const THINK_DANGLING_RE = /<think\b[^>]*>[\s\S]*$/i;
const THINK_TAG_RE = /<\/?think\b[^>]*>/gi;

export function sanitizeModelOutput(input: string): string {
  if (!input) return '';
  return input
    .replace(PICTOGRAPH_RE, '')
    .replace(THINK_BLOCK_RE, '')
    .replace(THINK_DANGLING_RE, '')
    .replace(THINK_TAG_RE, '')
    .trim();
}
