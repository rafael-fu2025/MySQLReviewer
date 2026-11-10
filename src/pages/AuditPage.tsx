import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronRight,
  Database,
  FileText,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Square,
  XCircle,
} from 'lucide-react';
import type { AuditReport, AuditSchedule, AuditStep, ReportSummary } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { api } from '@/lib/api';
import { postSse } from '@/lib/sse';
import { formatBytes, formatDate, formatDuration } from '@/lib/format';
import { AuditReportView } from '@/components/AuditReportView';
import { Markdown } from '@/components/Markdown';
import { Combobox } from '@/components/Combobox';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  ProgressBar,
  Spinner,
  StatCard,
} from '@/components/ui';
import { cn } from '@/lib/utils';

export function AuditPage() {
  const navigate = useNavigate();
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const databases = useAppStore((state) => state.databases);
  const selectedDatabase = useAppStore((state) => state.selectedDatabase);
  const providers = useAppStore((state) => state.providers);
  const toast = useAppStore((state) => state.toast);

  const [selected, setSelected] = useState<Set<string>>(() => {
    const first = databases.find((database) => database.name === selectedDatabase);
    if (first && !first.isSystem) return new Set([first.name]);
    const fallback = databases.find((database) => !database.isSystem);
    return fallback ? new Set([fallback.name]) : new Set();
  });
  const [search, setSearch] = useState('');
  const [includeAi, setIncludeAi] = useState(false);
  const [providerId, setProviderId] = useState(
    providers.find((provider) => provider.isDefault)?.id ?? providers[0]?.id ?? '',
  );
  const [model, setModel] = useState(
    providers.find((provider) => provider.isDefault)?.model ?? providers[0]?.model ?? '',
  );
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [steps, setSteps] = useState<AuditStep[]>([]);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [aiText, setAiText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [past, setPast] = useState<ReportSummary[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const userDatabases = useMemo(
    () => databases.filter((database) => !database.isSystem),
    [databases],
  );

  const filteredDatabases = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return userDatabases;
    return userDatabases.filter((database) => database.name.toLowerCase().includes(needle));
  }, [search, userDatabases]);

  // The selected database is picked up automatically while nothing is selected.
  // The state is adjusted while rendering so the auto-selection lands in the
  // same commit as the database change.
  const [autoSelectInputs, setAutoSelectInputs] = useState<{
    database: string | null;
    users: typeof userDatabases;
  } | null>(null);
  if (
    autoSelectInputs?.database !== selectedDatabase ||
    autoSelectInputs?.users !== userDatabases
  ) {
    setAutoSelectInputs({ database: selectedDatabase, users: userDatabases });
    if (
      selected.size === 0 &&
      selectedDatabase &&
      userDatabases.some((database) => database.name === selectedDatabase)
    ) {
      setSelected(new Set([selectedDatabase]));
    }
  }

  // Adopt the default provider as soon as the provider list is available.
  if (!providerId && providers.length > 0) {
    const first = providers.find((provider) => provider.isDefault) ?? providers[0];
    setProviderId(first.id);
    setModel(first.model);
  }

  const loadPast = (): void => {
    api
      .get<ReportSummary[]>('/api/reports?kind=audit')
      .then((reports) => {
        setPast(reports.slice(0, 8));
      })
      .catch(() => {
        // The report list is supplementary.
      });
  };

  useEffect(() => {
    loadPast();
  }, []);

  const toggleDatabase = (name: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAll = (): void => {
    setSelected(new Set(userDatabases.map((database) => database.name)));
  };

  const startAudit = async (): Promise<void> => {
    if (!activeProfileId) return;
    const databasesToAudit = Array.from(selected);
    if (databasesToAudit.length === 0) {
      toast('Select at least one database to audit.', 'warn');
      return;
    }
    const provider = providers.find((item) => item.id === providerId) ?? providers[0] ?? null;
    if (includeAi && !provider) {
      toast('Add an AI provider or disable the AI summary.', 'warn');
      return;
    }
    setRunning(true);
    setReport(null);
    setError(null);
    setProgress(0);
    setMessage('Starting audit…');
    setSteps([]);
    setAiText('');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await postSse(
        '/api/audit/run',
        {
          profileId: activeProfileId,
          databases: databasesToAudit,
          includeAi: Boolean(includeAi && provider),
          providerId: provider?.id,
          model: includeAi ? model : undefined,
        },
        {
          onEvent: ({ event, data }) => {
            if (event === 'step') {
              const step = data as AuditStep;
              setSteps((current) => {
                const index = current.findIndex((item) => item.key === step.key);
                if (index < 0) return [...current, step];
                const next = [...current];
                next[index] = step;
                return next;
              });
            } else if (event === 'progress') {
              const payload = data as { percent?: number; message?: string };
              if (payload.percent != null) setProgress(payload.percent);
              if (payload.message) setMessage(payload.message);
            } else if (event === 'ai-delta') {
              const payload = data as { text?: string };
              if (payload.text) setAiText((current) => current + payload.text);
            } else if (event === 'report') {
              const payload = data as { report?: AuditReport };
              if (payload.report) {
                setReport(payload.report);
                setProgress(100);
                setMessage('Audit complete.');
                setRunning(false);
                loadPast();
              }
            } else if (event === 'error') {
              const payload = data as { message?: string };
              setError(payload.message ?? 'Audit failed.');
              setRunning(false);
            } else if (event === 'done') {
              setRunning(false);
            }
          },
          onError: (err) => {
            setError(err instanceof Error ? err.message : String(err));
            setRunning(false);
          },
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
      setRunning(false);
    } finally {
      abortRef.current = null;
    }
  };

  const stopWatching = (): void => {
    // Client-only: the server keeps auditing and still saves the report.
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const totalTables = userDatabases
    .filter((database) => selected.has(database.name))
    .reduce((sum, database) => sum + database.tableCount, 0);
  const totalBytes = userDatabases
    .filter((database) => selected.has(database.name))
    .reduce((sum, database) => sum + database.sizeBytes, 0);

  return (
    <div className="page">
      <PageHeader
        title="Audit"
        subtitle="Run all checks against the selected databases."
        actions={
          <>
            <span className="text-2xs text-muted">
              {selected.size} selected · {totalTables} tables
            </span>
            <Button variant="tertiary" size="sm" icon={<RefreshCw size={12} />} onClick={loadPast}>
              Refresh
            </Button>
          </>
        }
      />

      {error ? (
        <div className="callout danger flex items-start gap-2">
          <XCircle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {running ? (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Spinner size={16} />
            <span className="text-sm font-semibold">Running audit</span>
            <span className="text-2xs text-muted">{message}</span>
            <span className="ml-auto font-mono text-2xs">{progress}%</span>
            <Button variant="tertiary" size="sm" icon={<Square size={11} />} onClick={stopWatching}>
              Stop watching
            </Button>
          </div>
          <div className="mt-1 text-2xs text-muted">
            Stop watching only closes this view. The audit keeps running on the server and the
            report is still saved to Reports.
          </div>
          <div className="mt-2">
            <ProgressBar percent={progress} />
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {steps.map((step) => (
              <div
                key={step.key}
                className="flex flex-wrap items-center gap-2 border-b border-line-soft py-1.5 text-2xs"
              >
                <Badge
                  tone={
                    step.status === 'done'
                      ? 'mint'
                      : step.status === 'running'
                        ? 'ember'
                        : step.status === 'error'
                          ? 'danger'
                          : step.status === 'skipped'
                            ? 'warn'
                            : 'neutral'
                  }
                >
                  {step.status}
                </Badge>
                <span className="text-ink-soft">{step.label}</span>
                {step.detail ? <span className="text-muted">— {step.detail}</span> : null}
                {step.durationMs != null ? (
                  <span className="ml-auto font-mono text-2xs text-muted">
                    {formatDuration(step.durationMs)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          {aiText ? (
            <div className="mt-3 rounded-xl border border-line-soft bg-panel-2 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles size={13} className="text-ember" />
                <span className="text-2xs font-semibold">AI summary</span>
              </div>
              <Markdown>{aiText}</Markdown>
            </div>
          ) : null}
        </Card>
      ) : report ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<ScanSearch size={12} />}
              onClick={() => setReport(null)}
            >
              New audit
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              icon={<ChevronRight size={12} />}
              onClick={() => navigate(`/reports/${report.id}`)}
            >
              Open report
            </Button>
            <Badge tone="mint" className="ml-auto">
              <CheckCircle2 size={10} /> complete in {formatDuration(report.durationMs)}
            </Badge>
          </div>
          <AuditReportView report={report} />
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="section-title">Databases</div>
                <Button variant="tertiary" size="sm" onClick={selectAll}>
                  Select all
                </Button>
                <Button variant="tertiary" size="sm" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
              <Input
                className="mb-3 text-xs"
                placeholder="Filter databases…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="scroll-fade-bottom flex max-h-[420px] flex-col gap-1.5 overflow-auto pr-1">
                {filteredDatabases.map((database) => (
                  <button
                    key={database.name}
                    type="button"
                    className={cn(
                      'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition',
                      selected.has(database.name)
                        ? 'border-ember/40 bg-ember/5'
                        : 'border-line-soft bg-panel-2 hover:border-line',
                    )}
                    onClick={() => toggleDatabase(database.name)}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        selected.has(database.name)
                          ? 'border-ember bg-ember text-[#1c0e05]'
                          : 'border-line bg-panel-3',
                      )}
                    >
                      {selected.has(database.name) ? <CheckCircle2 size={11} /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-ink">
                        {database.name}
                      </span>
                      <span className="block font-mono text-2xs text-muted">
                        {database.tableCount} tables · {database.viewCount} views ·{' '}
                        {formatBytes(database.sizeBytes)}
                      </span>
                    </span>
                  </button>
                ))}
                {filteredDatabases.length === 0 ? (
                  <EmptyState
                    icon={<Database size={20} />}
                    title="No user databases"
                    copy="The server only exposes system schemas to this account."
                  />
                ) : null}
              </div>
            </Card>

            <div className="flex flex-col gap-3">
              <Card className="p-4">
                <div className="section-title mb-3">Run options</div>
                <div className="grid grid-cols-2 gap-2">
                  <StatCard label="On-disk size" value={formatBytes(totalBytes)} />
                </div>
                <div className="mt-3 border-t border-line-soft pt-3">
                  {providers.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <Checkbox label="AI summary" checked={includeAi} onChange={setIncludeAi} />
                      {includeAi ? (
                        <div className="grid grid-cols-1 gap-2">
                          <Field label="Provider">
                            <Combobox
                              options={providers.map((provider) => ({
                                value: provider.id,
                                label: provider.name,
                                description: provider.model,
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
                          <Field label="Model">
                            <Input
                              className="font-mono text-2xs"
                              value={model}
                              onChange={(event) => setModel(event.target.value)}
                            />
                          </Field>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="callout info flex items-start gap-2">
                      <Sparkles size={14} className="mt-0.5 shrink-0" />
                      <div>
                        No AI provider is configured. The deterministic audit still runs.
                        <button
                          type="button"
                          className="ml-1 text-ember hover:underline"
                          onClick={() => navigate('/settings?tab=ai')}
                        >
                          Add one
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <Button
                  variant="primary"
                  className="mt-3 w-full"
                  icon={<ScanSearch size={14} />}
                  disabled={selected.size === 0}
                  onClick={() => void startAudit()}
                >
                  Run audit
                </Button>
                <div className="mt-2 text-center text-2xs text-muted">
                  Read-only — schema, indexes, accounts, configuration, and query performance.
                </div>
              </Card>

              {past.length > 0 ? (
                <Card className="p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <div className="section-title">Recent audits</div>
                    <Button
                      variant="tertiary"
                      size="sm"
                      className="ml-auto"
                      onClick={() => navigate('/reports')}
                    >
                      All reports
                    </Button>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {past.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="flex items-center gap-2 rounded-lg border border-line-soft bg-panel-2 px-2.5 py-2 text-left hover:border-ember/35"
                        onClick={() => navigate(`/reports/${item.id}`)}
                      >
                        <FileText size={13} className="text-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-2xs text-ink-soft">
                            {item.title}
                          </span>
                          <span className="block text-2xs text-muted">
                            {formatDate(item.createdAt)} · {item.findingsTotal} findings
                          </span>
                        </span>
                        <Badge
                          tone={item.score >= 80 ? 'mint' : item.score >= 60 ? 'warn' : 'danger'}
                        >
                          {item.score} {item.grade}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </Card>
              ) : null}

              <AuditSchedulesCard
                profileId={activeProfileId}
                databases={Array.from(selected)}
                onSaved={loadPast}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Recurring audit schedules, administrators only. A schedule reruns the
 * deterministic pipeline on its interval — never the AI step — and drops the
 * report into the normal Reports page.
 */
function AuditSchedulesCard({
  profileId,
  databases,
  onSaved,
}: {
  profileId: string | null;
  databases: string[];
  onSaved: () => void;
}) {
  const currentUser = useAppStore((state) => state.currentUser);
  const toast = useAppStore((state) => state.toast);
  const [schedules, setSchedules] = useState<AuditSchedule[] | null>(null);
  const [intervalHours, setIntervalHours] = useState('24');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = currentUser?.role === 'admin';

  const load = useCallback(async (): Promise<void> => {
    try {
      const loaded = await api.get<AuditSchedule[]>('/api/audit/schedules');
      setSchedules(loaded);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!admin) return;
    void (async () => {
      await load();
    })();
  }, [admin, load]);

  if (!admin) return null;

  const create = async (): Promise<void> => {
    if (!profileId || databases.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/audit/schedules', {
        profileId,
        databases,
        intervalHours: Math.max(1, Math.min(Number(intervalHours) || 24, 168)),
      });
      await load();
      onSaved();
      toast?.('Audit scheduled.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (schedule: AuditSchedule): Promise<void> => {
    setBusy(true);
    try {
      await api.put(`/api/audit/schedules/${schedule.id}`, { enabled: !schedule.enabled });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (schedule: AuditSchedule): Promise<void> => {
    setBusy(true);
    try {
      await api.del(`/api/audit/schedules/${schedule.id}`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="section-title mb-1">Scheduled audits</div>
      <div className="mb-3 max-w-xl text-2xs leading-4 text-muted">
        Rerun the deterministic checks on an interval — no AI, no unattended cost. Reports land in
        Reports.
      </div>
      {error ? (
        <div className="callout danger mb-2 text-2xs" role="alert">
          {error}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <Field label="Every (hours)" className="w-28">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={168}
            value={intervalHours}
            onChange={(event) => setIntervalHours(event.target.value)}
          />
        </Field>
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={!profileId || databases.length === 0}
          onClick={() => void create()}
        >
          Schedule current selection
        </Button>
      </div>
      {schedules && schedules.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              className="flex items-center gap-2 rounded-lg border border-line-soft bg-panel-2 px-2.5 py-2 text-2xs"
            >
              <Badge
                tone={
                  schedule.lastStatus === 'error' ? 'danger' : schedule.enabled ? 'mint' : 'neutral'
                }
              >
                {schedule.lastStatus ?? (schedule.enabled ? 'pending' : 'off')}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-muted">
                every {schedule.intervalHours}h · {schedule.databases.join(', ')}
                {schedule.lastError ? ` · ${schedule.lastError}` : ''}
              </span>
              <Button
                variant="tertiary"
                size="sm"
                disabled={busy}
                onClick={() => void toggle(schedule)}
              >
                {schedule.enabled ? 'Pause' : 'Resume'}
              </Button>
              <Button
                variant="tertiary"
                size="sm"
                disabled={busy}
                onClick={() => void remove(schedule)}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
