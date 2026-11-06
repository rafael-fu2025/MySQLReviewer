import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react';
import type { AgentToolCallView } from '@shared/types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * The tool calls of one assistant turn.
 *
 * One call renders as a single row; several render under one collapsible
 * header so a long chain does not bury the answer. A row expands to its exact
 * input and output, and a failed row starts expanded — that is the row the
 * user needs to read.
 *
 * A finished `propose_sql` call renders as a proposal card instead: its SQL
 * with Insert/Copy actions. The agent never runs what it proposes — the user
 * decides.
 */
export function ToolCallList({
  calls,
  onInsertSql,
}: {
  calls: AgentToolCallView[];
  onInsertSql?: (sql: string) => void;
}) {
  if (calls.length === 0) return null;
  if (calls.length === 1) {
    return <ToolCallRow call={calls[0]} onInsertSql={onInsertSql} />;
  }
  return (
    <Collapsible className="ai-tools">
      <CollapsibleTrigger className="ai-tools-toggle">
        <ChevronRight size={12} className="ai-tools-chevron" aria-hidden="true" />
        <span>
          {calls.length} tool calls · latest: {calls[calls.length - 1].name}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ai-tools-list">
          {calls.map((call) => (
            <ToolCallRow key={call.id} call={call} onInsertSql={onInsertSql} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCallRow({
  call,
  onInsertSql,
}: {
  call: AgentToolCallView;
  onInsertSql?: (sql: string) => void;
}) {
  // A failed row is the one the user needs to read, so it starts expanded.
  const [open, setOpen] = useState(call.status === 'error');
  const running = call.status === 'running';

  if (call.name === 'propose_sql' && !running) {
    return <ProposalCard call={call} onInsertSql={onInsertSql} />;
  }

  const argsPreview = Object.entries(call.arguments)
    .slice(0, 3)
    .map(([key, value]) => `${key}="${summarize(value)}"`)
    .join('  ');

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="ai-tool-row">
      <CollapsibleTrigger
        className="ai-tool-head"
        data-status={call.status}
        aria-label={`Tool ${call.name} ${call.status}`}
      >
        {running ? (
          <Loader2 size={12} className="ai-tool-spin" aria-hidden="true" />
        ) : call.status === 'error' ? (
          <XCircle size={12} className="ai-tool-error-icon" aria-hidden="true" />
        ) : (
          <Check size={12} className="ai-tool-ok-icon" aria-hidden="true" />
        )}
        <span className="ai-tool-name">{call.name}</span>
        {argsPreview ? <span className="ai-tool-args">{argsPreview}</span> : null}
        {call.durationMs != null && !running ? (
          <span className="ai-tool-duration">{formatDuration(call.durationMs)}</span>
        ) : null}
        {open ? (
          <ChevronDown size={12} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ai-tool-detail">
          <div className="ai-tool-section">
            <div className="mono-label">input</div>
            <pre className="ai-tool-pre">{JSON.stringify(call.arguments, null, 2)}</pre>
          </div>
          {call.error ? (
            <div className="ai-tool-section">
              <div className="mono-label">error</div>
              <pre className="ai-tool-pre ai-tool-pre-error">{call.error}</pre>
            </div>
          ) : null}
          {call.output ? (
            <div className="ai-tool-section">
              <div className="mono-label">output</div>
              <pre className={cn('ai-tool-pre', call.status === 'error' && 'ai-tool-pre-error')}>
                {call.output}
              </pre>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A finished `propose_sql` call: the statement, an optional rationale, and
 * the two actions. No expand toggle — the SQL is the whole point of the row.
 */
function ProposalCard({
  call,
  onInsertSql,
}: {
  call: AgentToolCallView;
  onInsertSql?: (sql: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const failed = call.status === 'error';
  const sql = stringArg(call.arguments.sql);
  const title = stringArg(call.arguments.title) || 'SQL proposal';
  const rationale = stringArg(call.arguments.rationale);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // A denied clipboard is not worth an error surface; the SQL is
      // readable in the card itself.
    }
  };

  if (failed) {
    return (
      <Collapsible className="ai-tool-row">
        <CollapsibleTrigger className="ai-tool-head" data-status="error" aria-expanded="true">
          <XCircle size={12} className="ai-tool-error-icon" aria-hidden="true" />
          <span className="ai-tool-name">{title}</span>
          <span className="ai-tool-args">proposal failed</span>
          <ChevronDown size={12} aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ai-tool-detail">
            <div className="ai-tool-section">
              <div className="mono-label">error</div>
              <pre className="ai-tool-pre ai-tool-pre-error">
                {call.error ?? 'Invalid proposal.'}
              </pre>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <div className="ai-tool-row ai-proposal" data-status={call.status}>
      <div className="ai-tool-head" data-status="complete">
        {call.status === 'running' ? (
          <Loader2 size={12} className="ai-tool-spin" aria-hidden="true" />
        ) : (
          <Check size={12} className="ai-tool-ok-icon" aria-hidden="true" />
        )}
        <span className="ai-tool-name">{title}</span>
        {call.durationMs != null ? (
          <span className="ai-tool-duration">{formatDuration(call.durationMs)}</span>
        ) : null}
      </div>
      <div className="ai-proposal-body">
        {rationale ? <div className="ai-proposal-rationale">{rationale}</div> : null}
        <pre className="ai-tool-pre">{sql}</pre>
        <div className="ai-proposal-actions">
          {onInsertSql && sql ? (
            <button
              type="button"
              className="ai-proposal-btn ai-proposal-btn-primary"
              onClick={() => onInsertSql(sql)}
            >
              Insert into editor
            </button>
          ) : null}
          {sql ? (
            <button type="button" className="ai-proposal-btn" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Short single-line rendering of one argument value. */
function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
