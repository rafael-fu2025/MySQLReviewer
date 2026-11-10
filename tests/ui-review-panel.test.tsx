import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AiReview, StaticReviewResult } from '@shared/types';
import { ReviewPanel } from '../src/components/ReviewPanel';

/**
 * A cancelled AI review used to hide the text that had already streamed in:
 * `aiRaw` was only rendered while the review was running or once a final `ai`
 * result existed, so after Cancel the partial output vanished. The partial
 * text now stays readable under a stopped marker.
 *
 * The AI view is gated behind the panel's own tab state (it opens when an `ai`
 * result arrives, which is also how the user reaches the Deep review button —
 * so a cancelled run always sits on that tab). A single static render cannot
 * click into that state, so the cancelled card itself is pinned by source
 * assertions and the reachable views are pinned by render.
 */

const review: StaticReviewResult = {
  sql: 'SELECT * FROM customers',
  statements: [{ sql: 'SELECT * FROM customers', kind: 'read', line: 1 }],
  findings: [],
  score: {
    score: 100,
    grade: 'A',
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    deductions: {
      correctness: 0,
      performance: 0,
      security: 0,
      schema: 0,
      config: 0,
      style: 0,
      maintainability: 0,
    },
  },
  context: {
    database: 'northwind',
    tables: [],
    truncated: false,
    charCount: 0,
    estimatedTokens: 0,
  },
  explain: null,
  suggestions: [],
  warnings: [],
};

const ai: AiReview = {
  providerId: 'p1',
  providerName: 'Test provider',
  model: 'test-model',
  verdict: 'pass',
  score: 92,
  findings: [],
  rewrite: null,
  markdown: 'The statement is fine.',
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  durationMs: 1200,
};

function renderPanel(props: {
  ai?: AiReview | null;
  aiRaw: string;
  aiRunning: boolean;
  aiError?: string | null;
}): string {
  return renderToStaticMarkup(
    <ReviewPanel
      review={review}
      ai={props.ai ?? null}
      aiRaw={props.aiRaw}
      aiStreaming={props.aiRunning}
      aiRunning={props.aiRunning}
      aiError={props.aiError ?? null}
      providers={[]}
      defaultProviderId={null}
      onDeepReview={() => {}}
      onCancelAi={() => {}}
      onSaveReport={() => {}}
      onJumpToLine={() => {}}
      onOpenSql={() => {}}
      onConfigureAi={() => {}}
      onRunReview={() => {}}
      chatContext={{ profileId: null, database: null, sql: review.sql }}
    />,
  );
}

describe('ReviewPanel AI output', () => {
  it('keeps the partial output readable after a cancel', () => {
    // The card hangs on "no result and not running, but text arrived" — the
    // state a Cancel leaves the tab in.
    const source = readFileSync(
      new URL('../src/components/ReviewPanel.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('!aiRunning && !ai && aiRaw');
    expect(source).toContain("'Review cancelled — partial response:'");
    expect(source).toContain("'The review stopped with an error — partial response:'");
    // The partial text renders inside the card, not only in the running view.
    const card = source.slice(source.indexOf('!aiRunning && !ai && aiRaw'));
    expect(card).toContain('{aiRaw}');
  });

  it('still offers the raw response once a final review arrived', () => {
    const html = renderPanel({ ai, aiRaw: 'raw model text', aiRunning: false });
    expect(html).toContain('Raw model response');
    expect(html).toContain('raw model text');
    expect(html).toContain('PASS');
  });

  it('shows no cancelled card while the review streams or once nothing ran', () => {
    const source = readFileSync(
      new URL('../src/components/ReviewPanel.tsx', import.meta.url),
      'utf8',
    );
    // The running card keeps its own Cancel affordance; the stopped card is
    // strictly the not-running branch.
    const runningCard = source.slice(
      source.indexOf('{aiRunning ? ('),
      source.indexOf('!aiRunning && !ai && aiRaw'),
    );
    expect(runningCard).toContain('Cancel');
  });
});
