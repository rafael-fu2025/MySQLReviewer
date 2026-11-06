import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportSqlSource } from '../src/components/ImportSqlModal';

/**
 * D-07 — the import modal only offered a file picker, so pasted SQL had no
 * path in, and its opening state gave the user nothing to act on.
 *
 * D-08 — the import modal was `size="wide"` while the sibling export modal
 * used the default width.
 */

function render(
  props: {
    fileName?: string | null;
    pasted?: string;
    status?: 'idle' | 'previewing' | 'ready' | 'running' | 'done';
  } = {},
): string {
  return renderToStaticMarkup(
    <ImportSqlSource
      fileName={props.fileName ?? null}
      pasted={props.pasted ?? ''}
      status={props.status ?? 'idle'}
      onFilePicked={() => {}}
      onPastedChange={() => {}}
      onReviewPasted={() => {}}
    />,
  );
}

describe('import SQL source', () => {
  it('offers a place to paste SQL', () => {
    const html = render();
    expect(html).toContain('Or paste SQL');
    expect(html).toContain('import-sql-paste');
    expect(html).toContain('<textarea');
  });

  it('says that nothing runs until the run step', () => {
    expect(render()).toContain('Nothing runs until you press Run');
  });

  it('keeps the file picker as the primary action', () => {
    const html = render();
    const buttonIndex = html.indexOf('Choose .sql file');
    expect(buttonIndex).toBeGreaterThan(-1);
    const buttonStart = html.lastIndexOf('<button', buttonIndex);
    expect(html.slice(buttonStart, buttonIndex)).toContain('btn-primary');
  });

  it('keeps the paste review separate from the file picker', () => {
    const html = render();
    expect(html).toContain('Review pasted SQL');
  });

  it('names the file that was chosen', () => {
    expect(render({ fileName: 'dump.sql' })).toContain('dump.sql');
  });

  it('does not use the wide modal', () => {
    const source = readFileSync(
      new URL('../src/components/ImportSqlModal.tsx', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/size="wide"/);
  });
});
