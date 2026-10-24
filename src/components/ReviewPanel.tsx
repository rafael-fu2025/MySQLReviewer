import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  MessageSquare,
  ScanSearch,
  Send,
  Sparkles,
  Square,
  Wand2,
  XCircle,
} from 'lucide-react';
import type { AiProvider, AiReview, StaticReviewResult } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { formatDuration } from '@/lib/format';
import { postSse } from '@/lib/sse';
import { FindingCard, FindingsHint, FindingsList } from './Findings';
import { Markdown } from './Markdown';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CopyButton,
  EmptyState,
  Field,
  Input,
  ScoreRing,
  Spinner,
  Tabs,
} from './ui';
import { cn } from '@/lib/utils';
import { Combobox } from './Combobox';

function verdictTone(verdict: AiReview['verdict']): 'mint' | 'warn' | 'danger' | 'neutral' {
  if (verdict === 'pass') return 'mint';
  if (verdict === 'warn') return 'warn';
  if (verdict === 'fail') return 'danger';
  return 'neutral';
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function ReviewPanel({
  review,
  ai,
  aiRaw,
  aiStreaming,
  aiRunning,
  aiError,
  providers,
  defaultProviderId,
  onDeepReview,
  onCancelAi,
  onSaveReport,
  onJumpToLine,
  onOpenSql,
  onConfigureAi,
  onRunReview,
  chatContext,
}: {
  review: StaticReviewResult | null;
  ai: AiReview | null;
  aiRaw: string;
  aiStreaming: boolean;
  aiRunning: boolean;
  aiError: string | null;
  providers: AiProvider[];
  defaultProviderId: string | null;
  onDeepReview: (options: {
    providerId: string;
    model: string;
    includeSchema: boolean;
    includeExplain: boolean;
    analyze: boolean;
  }) => void;
  onCancelAi: () => void;
  onSaveReport: () => void;
  onJumpToLine: (line: number) => void;
  onOpenSql: (sql: string) => void;
  onConfigureAi: () => void;
  onRunReview: () => void;
  chatContext: {
    profileId: string | null;
    database: string | null;
    sql: string;
  };
}) {
  const toast = useAppStore((state) => state.toast);
  const [tab, setTab] = useState<'findings' | 'ai'>('findings');
  const initialProvider =
    providers.find((provider) => provider.id === defaultProviderId) ??
    providers.find((provider) => provider.isDefault) ??
    providers[0] ??
    null;
  const [providerId, setProviderId] = useState(initialProvider?.id ?? '');
  const [model, setModel] = useState(initialProvider?.model ?? '');
  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeExplain, setIncludeExplain] = useState(false);
  const [analyze, setAnalyze] = useState(false);
  const [chatMessages, setChatMessages] = useState<
    { role: 'user' | 'assistant'; content: string }[]
  >([]);
  const [chatInput, setChatInput] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Adopt the default provider as soon as the provider list is available. The
  // state is adjusted while rendering so the panel never renders an empty
  // provider selection first.
  if (!providerId && initialProvider) {
    setProviderId(initialProvider.id);
    setModel(initialProvider.model);
  }

  // A fresh AI review takes over the tab. Adjusting the state while rendering
  // switches tabs in the same commit instead of a second render from an effect.
  const [lastAi, setLastAi] = useState<AiReview | null>(null);
  if (ai !== lastAi) {
    setLastAi(ai);
    if (ai) setTab('ai');
  }

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
      chatAbortRef.current = null;
    };
  }, []);

  const provider = providers.find((item) => item.id === providerId) ?? null;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chatDraft, chatMessages]);

  const sendChat = async (): Promise<void> => {
    const text = chatInput.trim();
    if (!text || !provider || chatStreaming) return;
    const nextMessages: { role: 'user' | 'assistant'; content: string }[] = [
      ...chatMessages,
      { role: 'user', content: text },
    ];
    setChatMessages(nextMessages);
    setChatInput('');
    setChatDraft('');
    setChatError(null);
    setChatStreaming(true);
    const controller = new AbortController();
    chatAbortRef.current = controller;
    let accumulated = '';
    try {
      await postSse(
        '/api/ai/chat',
        {
          providerId: provider.id,
          model,
          messages: nextMessages,
          context: {
            sql: chatContext.sql,
            database: chatContext.database,
            profileId: chatContext.profileId,
            includeSchema: true,
          },
        },
        {
          onEvent: ({ event, data }) => {
            if (event === 'delta') {
              const payload = data as { text?: string };
              if (payload.text) {
                accumulated += payload.text;
                setChatDraft(accumulated);
              }
            } else if (event === 'result') {
              const payload = data as { text?: string };
              const answer = payload.text?.trim() || accumulated;
              if (answer) {
                setChatMessages((current) => [...current, { role: 'assistant', content: answer }]);
              }
              setChatDraft('');
              setChatStreaming(false);
            } else if (event === 'error') {
              const payload = data as { message?: string };
              setChatError(payload.message ?? 'The AI chat request failed.');
              setChatStreaming(false);
              setChatDraft('');
            } else if (event === 'done') {
              setChatStreaming(false);
            }
          },
        },
        controller.signal,
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setChatError(error instanceof Error ? error.message : String(error));
      }
      setChatStreaming(false);
      setChatDraft('');
    } finally {
      if (chatAbortRef.current === controller) chatAbortRef.current = null;
    }
  };

  const cancelChat = (): void => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setChatStreaming(false);
    setChatDraft('');
  };

  if (!review) {
    return (
      <EmptyState
        icon={<ScanSearch size={22} />}
        title="No review yet"
        copy="Run Review to check this statement with deterministic rules, schema context, and optional EXPLAIN insights."
        action={
          <Button variant="primary" icon={<ScanSearch size={14} />} onClick={onRunReview}>
            Review this statement
          </Button>
        }
      />
    );
  }

  const aiFindings = ai?.findings ?? [];
  const findingCount = review.findings.length + aiFindings.length;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="card flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <ScoreRing score={review.score.score} grade={review.score.grade} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-bold">Deterministic review</span>
            <Badge tone="neutral">{countLabel(review.findings.length, 'finding')}</Badge>
            {review.context.database ? <Badge tone="ember">{review.context.database}</Badge> : null}
            {review.context.truncated ? <Badge tone="warn">context truncated</Badge> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(['critical', 'high', 'medium', 'low', 'info'] as const)
              .filter((severity) => review.score.counts[severity] > 0)
              .map((severity) => (
                <span key={severity} className={cn('badge', `sev-${severity}`)}>
                  {review.score.counts[severity]} {severity}
                </span>
              ))}
            {review.findings.length === 0 ? <Badge tone="mint">clean</Badge> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10.5px] text-muted">
            <span>{countLabel(review.context.tables.length, 'table')} in context</span>
            <span>~{review.context.estimatedTokens.toLocaleString()} tokens</span>
            {review.explain ? <span>{review.explain.insights.length} plan insights</span> : null}
          </div>
          {review.context.tables.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {review.context.tables.map((table) => (
                <span
                  key={`${table.database}.${table.table}`}
                  className="rounded border border-line-soft bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-muted"
                >
                  {table.table}
                  <span className="text-muted/60"> · {table.columns.length} cols</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {review.warnings.length > 0 ? (
        <div className="callout flex flex-col gap-1">
          {review.warnings.map((warning, index) => (
            <div key={index} className="flex items-start gap-2">
              <XCircle size={13} className="mt-0.5 shrink-0 text-warn" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      <Tabs
        items={[
          { id: 'findings', label: 'Rules', count: findingCount },
          {
            id: 'ai',
            label: 'AI review',
            icon: <Sparkles size={12} />,
            count: aiFindings.length || undefined,
          },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'findings' ? (
        <div className="flex flex-col gap-4">
          <FindingsHint findings={review.findings} />
          <FindingsList
            findings={review.findings}
            onJumpToLine={onJumpToLine}
            emptyTitle="No deterministic findings"
            emptyCopy="The rule engine did not find anything. Use Explain or an AI review for a second opinion."
          />

          {review.suggestions.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="section-title">Index suggestions</div>
              {review.suggestions.map((suggestion) => (
                <div key={suggestion.statement} className="finding sev-info p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{suggestion.confidence}</Badge>
                    <span className="font-mono text-[11px] text-ink">
                      {suggestion.database}.{suggestion.table}
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                      ({suggestion.columns.join(', ')})
                    </span>
                  </div>
                  <div className="finding-message">{suggestion.reason}</div>
                  <pre className="code-block mt-2 text-[10.5px]">{suggestion.statement}</pre>
                  <div className="mt-1 flex justify-end">
                    <CopyButton text={suggestion.statement} label="Copy ALTER" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {review.explain && review.explain.insights.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="section-title">EXPLAIN insights</div>
              {review.explain.insights.map((finding) => (
                <FindingCard key={finding.id} finding={finding} compact />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.length === 0 ? (
            <div className="callout info flex flex-wrap items-center gap-2">
              <Sparkles size={14} />
              <span className="flex-1">Add a provider to enable deep review.</span>
              <Button size="sm" variant="secondary" onClick={onConfigureAi}>
                Add provider
              </Button>
            </div>
          ) : (
            <div className="card flex flex-col gap-3 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="Provider">
                  <Combobox
                    options={providers.map((item) => ({
                      value: item.id,
                      label: item.name,
                      description: item.isDefault ? `${item.model} · default` : item.model,
                    }))}
                    value={providerId}
                    onChange={(value) => {
                      const next = providers.find((item) => item.id === value);
                      setProviderId(value);
                      if (next) setModel(next.model);
                    }}
                    clearable={false}
                  />
                </Field>
                <Field label="Model" hint={provider ? `${provider.type} endpoint` : undefined}>
                  <Input
                    className="font-mono text-[11.5px]"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={provider?.model}
                    list="review-models"
                  />
                  <datalist id="review-models">
                    {(provider?.models ?? []).map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox
                  label="Include schema context"
                  checked={includeSchema}
                  onChange={setIncludeSchema}
                />
                <Checkbox
                  label="Include EXPLAIN plan"
                  checked={includeExplain}
                  onChange={setIncludeExplain}
                />
                <Checkbox
                  label="Include ANALYZE (runs the query)"
                  checked={analyze}
                  onChange={setAnalyze}
                  disabled={!includeExplain}
                />
                <Button
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  icon={aiRunning ? <Spinner size={12} /> : <Sparkles size={13} />}
                  loading={aiRunning}
                  disabled={!providerId || !model.trim()}
                  onClick={() =>
                    onDeepReview({
                      providerId,
                      model,
                      includeSchema,
                      includeExplain,
                      analyze: includeExplain && analyze,
                    })
                  }
                >
                  Deep review
                </Button>
              </div>
            </div>
          )}

          {aiError ? (
            <div className="callout danger flex items-start gap-2">
              <XCircle size={14} className="mt-0.5 shrink-0" />
              <span>{aiError}</span>
            </div>
          ) : null}

          {aiRunning ? (
            <div className="card p-3">
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <Spinner size={13} />
                <span>{aiStreaming ? 'Streaming the review…' : 'Waiting for the provider…'}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  icon={<Square size={11} />}
                  onClick={onCancelAi}
                >
                  Cancel
                </Button>
              </div>
              {aiRaw ? (
                <pre className="code-block mt-2 max-h-56 whitespace-pre-wrap text-[10px]">
                  {aiRaw}
                </pre>
              ) : null}
            </div>
          ) : null}

          {ai ? (
            <div className="flex flex-col gap-3">
              <div className="card flex flex-wrap items-center gap-3 p-3">
                <Badge tone={verdictTone(ai.verdict)}>{ai.verdict.toUpperCase()}</Badge>
                {ai.score != null ? (
                  <span className="font-mono text-[12px] font-bold">{ai.score}/100</span>
                ) : null}
                <span className="text-[11px] text-muted">
                  {ai.providerName} · {ai.model} · {formatDuration(ai.durationMs)}
                </span>
                {ai.usage ? (
                  <span className="ml-auto font-mono text-[10px] text-muted">
                    {ai.usage.inputTokens ?? '?'} in · {ai.usage.outputTokens ?? '?'} out
                  </span>
                ) : null}
                <Button variant="secondary" size="sm" onClick={onSaveReport}>
                  Save report
                </Button>
              </div>

              {ai.markdown ? <Markdown>{ai.markdown}</Markdown> : null}

              {ai.findings.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <div className="section-title">AI findings</div>
                  {ai.findings.map((finding) => (
                    <FindingCard key={finding.id} finding={finding} onJumpToLine={onJumpToLine} />
                  ))}
                </div>
              ) : null}

              {ai.rewrite ? (
                <div className="card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Wand2 size={14} className="text-ember" />
                    <span className="text-[12.5px] font-bold">Suggested rewrite</span>
                    <Badge tone="info">review before running</Badge>
                    <div className="ml-auto flex gap-1">
                      <CopyButton text={ai.rewrite.sql} label="Copy SQL" />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<ChevronRight size={12} />}
                        onClick={() => onOpenSql(ai.rewrite?.sql ?? '')}
                      >
                        Open in editor
                      </Button>
                    </div>
                  </div>
                  <pre className="code-block mt-2">{ai.rewrite.sql}</pre>
                  {ai.rewrite.explanation ? (
                    <div className="mt-2 text-[11.5px] text-muted">{ai.rewrite.explanation}</div>
                  ) : null}
                </div>
              ) : null}

              {aiRaw && !aiStreaming ? (
                <details className="rounded-xl border border-line-soft bg-panel-2/40 p-3">
                  <summary className="cursor-pointer text-[10.5px] font-semibold text-muted">
                    Raw model response
                  </summary>
                  <pre className="code-block mt-2 max-h-56 whitespace-pre-wrap text-[10px]">
                    {aiRaw}
                  </pre>
                </details>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Copy size={12} />}
                  onClick={async () => {
                    const ok = await navigator.clipboard
                      .writeText(ai.markdown || ai.summary || '')
                      .then(() => true)
                      .catch(() => false);
                    toast(
                      ok ? 'AI review copied.' : 'Could not copy the review.',
                      ok ? 'success' : 'error',
                    );
                  }}
                >
                  Copy review
                </Button>
              </div>
            </div>
          ) : !aiRunning && providers.length > 0 ? (
            <div className="callout mint flex items-start gap-2">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-mint" />
              <span>
                AI review is optional. It receives the SQL, referenced schema, deterministic
                findings, and (if enabled) the EXPLAIN plan — only when you click Deep review.
              </span>
            </div>
          ) : null}

          {providers.length > 0 ? (
            <Card className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <MessageSquare size={14} className="text-ember" />
                <span className="text-[12.5px] font-semibold">Ask a follow-up</span>
                <Badge tone="neutral" className="ml-auto">
                  {provider?.name ?? 'AI'} · {model}
                </Badge>
                {chatMessages.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setChatMessages([]);
                      setChatError(null);
                      setChatDraft('');
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
              <div className="mt-2 flex max-h-[340px] flex-col gap-2 overflow-auto pr-1">
                {chatMessages.length === 0 && !chatDraft ? (
                  <div className="rounded-xl border border-line-soft bg-panel-2/40 px-3 py-4 text-[11.5px] text-muted">
                    Ask why a rule fired, how an index would change the plan, or whether a rewrite
                    is safe. The current SQL and referenced schema are included as context.
                  </div>
                ) : null}
                {chatMessages.map((message, index) => (
                  <div
                    key={index}
                    className={cn(
                      'max-w-[92%] rounded-xl border px-3 py-2',
                      message.role === 'user'
                        ? 'self-end border-ember/25 bg-ember/10'
                        : 'self-start border-line-soft bg-panel-2/60',
                    )}
                  >
                    <div className="mono-label mb-1">
                      {message.role === 'user' ? 'you' : (provider?.name ?? 'assistant')}
                    </div>
                    {message.role === 'assistant' ? (
                      <Markdown>{message.content}</Markdown>
                    ) : (
                      <div className="whitespace-pre-wrap text-[12px] text-ink-soft">
                        {message.content}
                      </div>
                    )}
                  </div>
                ))}
                {chatDraft ? (
                  <div className="max-w-[92%] self-start rounded-xl border border-line-soft bg-panel-2/60 px-3 py-2">
                    <div className="mono-label mb-1 flex items-center gap-2">
                      {provider?.name ?? 'assistant'}
                      <Spinner size={10} />
                    </div>
                    <Markdown>{chatDraft}</Markdown>
                  </div>
                ) : null}
                <div ref={chatEndRef} />
              </div>
              {chatError ? (
                <div className="callout danger mt-2 flex items-start gap-2">
                  <XCircle size={13} className="mt-0.5 shrink-0" />
                  <span>{chatError}</span>
                </div>
              ) : null}
              <div className="mt-2 flex items-end gap-2">
                <Input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Ask about this statement…"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendChat();
                    }
                  }}
                />
                {chatStreaming ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Square size={11} />}
                    onClick={cancelChat}
                  >
                    Stop
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Send size={12} />}
                    onClick={() => void sendChat()}
                    disabled={!chatInput.trim() || !provider}
                  >
                    Send
                  </Button>
                )}
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
