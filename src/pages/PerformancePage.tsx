import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Database,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  Search,
  Timer,
  XCircle,
  Zap,
} from 'lucide-react';
import type { PerformanceMetrics, PerformanceSnapshot, ProcessInfo } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { api } from '@/lib/api';
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
} from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  SectionTitle,
  Spinner,
  StatCard,
  Tabs,
} from '@/components/ui';
import { cn } from '@/lib/utils';

function Sparkline({ values, color = '#ff8a3d' }: { values: number[]; color?: string }) {
  // Fewer than two samples cannot draw a line. A flat baseline says so
  // instead of leaving a hole the height of the chart.
  if (values.length < 2) {
    return (
      <div className="flex h-[42px] items-end" aria-hidden="true">
        <div className="h-px w-full bg-line-soft" />
      </div>
    );
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 30 - ((value - min) / (max - min || 1)) * 26;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg className="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function slowRatio(metrics: PerformanceMetrics): number {
  if (metrics.tmpTables === 0) return 0;
  return metrics.tmpDiskTables / metrics.tmpTables;
}

function varsOf(snapshot: PerformanceSnapshot | null): [string, string][] {
  if (!snapshot) return [];
  return Object.entries(snapshot.variables).sort(([a], [b]) => a.localeCompare(b));
}

export function PerformancePage() {
  const navigate = useNavigate();
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const currentUser = useAppStore((state) => state.currentUser);
  const unlockedUntil = useAppStore((state) => state.unlockedUntil);
  const toast = useAppStore((state) => state.toast);
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null);
  const [history, setHistory] = useState<PerformanceMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState<'overview' | 'processes' | 'slow' | 'variables'>('overview');
  const [processFilter, setProcessFilter] = useState('');
  const [variableFilter, setVariableFilter] = useState('');
  const [killTarget, setKillTarget] = useState<ProcessInfo | null>(null);
  const [killing, setKilling] = useState(false);
  const snapshotRef = useRef<PerformanceSnapshot | null>(null);

  const isAdmin = currentUser?.role === 'admin';

  // `unlockedUntil` is an absolute timestamp. The clock is read in an effect
  // so the flag flips exactly when the unlock window closes, instead of
  // reading the time while rendering.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!unlockedUntil) return;
    const remaining = unlockedUntil - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [unlockedUntil]);

  const unlocked = isAdmin || Boolean(unlockedUntil && unlockedUntil > now);

  const load = async (quiet = false): Promise<void> => {
    if (!activeProfileId) {
      setSnapshot(null);
      snapshotRef.current = null;
      setHistory([]);
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await api.get<PerformanceSnapshot>(
        `/api/db/${encodeURIComponent(activeProfileId)}/performance`,
      );
      setSnapshot(result);
      snapshotRef.current = result;
      setHistory((current) => [...current.slice(-29), result.metrics]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // The load writes loading/error state, so it runs in a task instead of
    // synchronously in the effect body: that keeps the mount render free of
    // cascading setState calls.
    const start = setTimeout(() => void load(), 0);
    if (!activeProfileId) return () => clearTimeout(start);
    const timer = setInterval(() => {
      if (!paused && document.visibilityState === 'visible') void load(true);
    }, 5_000);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileId, paused]);

  const metrics = snapshot?.metrics;

  const filteredProcesses = useMemo(() => {
    const list = snapshot?.processlist ?? [];
    const needle = processFilter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((process) =>
      [process.user, process.host, process.db ?? '', process.command, process.info ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [processFilter, snapshot?.processlist]);

  const filteredVariables = useMemo(() => {
    const entries = varsOf(snapshot);
    const needle = variableFilter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(([name, value]) => `${name} ${value}`.toLowerCase().includes(needle));
  }, [snapshot, variableFilter]);

  const topTableMax = Math.max(1, ...(snapshot?.topTables.map((table) => table.totalBytes) ?? [1]));

  const killProcess = async (): Promise<void> => {
    if (!killTarget || !activeProfileId) return;
    setKilling(true);
    try {
      await api.post(`/api/db/${encodeURIComponent(activeProfileId)}/kill`, {
        processId: killTarget.id,
        confirm: true,
      });
      toast(`Killed session ${killTarget.id}.`, 'success');
      setKillTarget(null);
      await load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setKilling(false);
    }
  };

  if (!activeProfileId) {
    return (
      <div className="page">
        <PageHeader title="Performance" subtitle="Live throughput, sessions, and configuration." />
        <EmptyState
          icon={<Database size={24} />}
          title="Connect to a database"
          action={
            <Button variant="primary" onClick={() => navigate('/connect')}>
              Connect
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Performance"
        subtitle="A live snapshot of server throughput, sessions, slow work, and configuration."
        actions={
          <>
            <Badge tone={paused ? 'warn' : 'mint'}>{paused ? 'paused' : 'polling every 5s'}</Badge>
            <Button
              variant="secondary"
              size="sm"
              icon={paused ? <Play size={12} /> : <Pause size={12} />}
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
              onClick={() => void load()}
              loading={loading}
            >
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

      {loading && !snapshot ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="skeleton h-24" />
          ))}
        </div>
      ) : snapshot && metrics ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Queries / second"
              value={metrics.qps.toFixed(1)}
              sub={`${formatNumber(metrics.queries)} total`}
              icon={<Zap size={14} />}
              tone="ember"
            />
            <StatCard
              label="Threads"
              value={`${metrics.threadsConnected} / ${metrics.threadsRunning}`}
              sub="connected / running"
              icon={<Activity size={14} />}
              tone="info"
            />
            <StatCard
              label="Buffer pool hit"
              value={
                metrics.bufferPoolHitRatio != null ? formatPercent(metrics.bufferPoolHitRatio) : '—'
              }
              sub="InnoDB read cache"
              icon={<Gauge size={14} />}
              tone="mint"
            />
            <StatCard
              label="Slow queries"
              value={formatNumber(metrics.slowQueries)}
              sub="since startup"
              icon={<Timer size={14} />}
              tone="warn"
            />
            <StatCard
              label="Temp tables on disk"
              value={formatPercent(slowRatio(metrics))}
              sub={`${formatNumber(metrics.tmpDiskTables)} of ${formatNumber(metrics.tmpTables)}`}
              tone={slowRatio(metrics) > 0.1 ? 'warn' : 'mint'}
            />
            <StatCard
              label="Full joins"
              value={formatNumber(metrics.selectFullJoin)}
              sub="joins without indexes"
              tone={metrics.selectFullJoin > 0 ? 'warn' : 'mint'}
            />
            <StatCard
              label="Aborted connects"
              value={formatNumber(metrics.abortedConnects)}
              sub="since startup"
              tone={metrics.abortedConnects > 0 ? 'warn' : 'mint'}
            />
            <StatCard
              label="Uptime"
              value={formatDuration(metrics.uptimeSeconds * 1000)}
              sub={`max used ${formatNumber(metrics.maxUsedConnections)} connections`}
            />
          </div>

          {/*
           * The trends used to live inside the first two tiles, which left
           * those tiles a different size and surface from the other six and
           * reserved an empty 42px band before any sample arrived. They get
           * their own panel now, so every tile in the row is the same tile.
           */}
          {history.length > 1 ? (
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <SectionTitle>Throughput trend</SectionTitle>
                <span className="text-2xs text-muted">last {history.length} samples</span>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <div className="stat-label">Queries / second</div>
                  <Sparkline values={history.map((item) => item.qps)} />
                </div>
                <div>
                  <div className="stat-label">Threads running</div>
                  <Sparkline values={history.map((item) => item.threadsRunning)} color="#60a5fa" />
                </div>
              </div>
            </Card>
          ) : null}

          <Tabs
            items={[
              { id: 'overview', label: 'Overview' },
              { id: 'processes', label: 'Processes', count: snapshot.processlist.length },
              { id: 'slow', label: 'Slow queries', count: snapshot.slowQueries.length },
              {
                id: 'variables',
                label: 'Variables',
                count: Object.keys(snapshot.variables).length,
              },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === 'overview' ? (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card className="p-4">
                <div className="mb-3 flex items-center gap-2">
                  <div className="section-title">Largest tables</div>
                </div>
                {snapshot.topTables.length === 0 ? (
                  <div className="text-2xs text-muted">No table statistics available.</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {snapshot.topTables.map((table) => (
                      <div key={`${table.database}.${table.table}`}>
                        <div className="flex items-center justify-between gap-2 font-mono text-2xs">
                          <span className="truncate text-ink-soft">
                            {table.database}.{table.table}
                          </span>
                          <span className="text-muted">{formatBytes(table.totalBytes)}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-3">
                          <div
                            className="h-full rounded-full bg-ember/70"
                            style={{
                              width: `${Math.max(3, (table.totalBytes / topTableMax) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card className="p-4">
                <div className="mb-3 flex items-center gap-2">
                  <div className="section-title">Replication</div>
                  <Badge
                    tone={snapshot.replication.configured ? 'mint' : 'neutral'}
                    className="ml-auto"
                  >
                    {snapshot.replication.configured ? 'configured' : 'not configured'}
                  </Badge>
                </div>
                {snapshot.replication.configured ? (
                  <div className="grid grid-cols-1 gap-2 text-2xs">
                    <div className="flex justify-between">
                      <span className="text-muted">IO thread</span>
                      <span className="font-mono">{snapshot.replication.ioRunning ?? '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">SQL thread</span>
                      <span className="font-mono">{snapshot.replication.sqlRunning ?? '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Lag</span>
                      <span className="font-mono">
                        {snapshot.replication.lagSeconds != null
                          ? `${snapshot.replication.lagSeconds}s`
                          : '—'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-2xs text-muted">Not configured as a replica.</div>
                )}
              </Card>

              <Card className="p-4 lg:col-span-2">
                <div className="mb-2 flex items-center gap-2">
                  <div className="section-title">Slow query source</div>
                  <span className="ml-auto text-2xs text-muted">{snapshot.slowQuerySource}</span>
                </div>
                {snapshot.slowQueryAdvice ? (
                  <div className="callout flex items-start gap-2">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
                    <div className="whitespace-pre-wrap font-mono text-2xs">
                      {snapshot.slowQueryAdvice}
                    </div>
                  </div>
                ) : (
                  <div className="text-2xs text-muted">
                    Slow query analysis is available from {snapshot.slowQuerySource}.
                  </div>
                )}
              </Card>
            </div>
          ) : null}

          {tab === 'processes' ? (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-line-soft p-3">
                <div className="relative min-w-[220px] flex-1">
                  <Search
                    size={12}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
                  />
                  <input
                    className="input input-search py-1.5 text-2xs"
                    value={processFilter}
                    onChange={(event) => setProcessFilter(event.target.value)}
                    placeholder="Filter by user, host, database, state…"
                    aria-label="Filter sessions"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={paused ? <Play size={12} /> : <Pause size={12} />}
                  onClick={() => setPaused((value) => !value)}
                >
                  {paused ? 'Resume' : 'Pause'}
                </Button>
              </div>
              <div className="overflow-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>User</th>
                      <th>Host</th>
                      <th>DB</th>
                      <th>Command</th>
                      <th>Time</th>
                      <th>State</th>
                      <th>Statement</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProcesses.map((process) => (
                      <tr key={process.id}>
                        <td>{process.id}</td>
                        <td>{process.user}</td>
                        <td>{process.host}</td>
                        <td>{process.db ?? '—'}</td>
                        <td>
                          <span className="font-mono text-2xs text-muted">{process.command}</span>
                        </td>
                        <td className={cn(process.timeSeconds > 60 && 'text-warn')}>
                          {process.timeSeconds}s
                        </td>
                        <td>{process.state ?? '—'}</td>
                        <td className="max-w-[360px] truncate" title={process.info ?? ''}>
                          {process.info ?? '—'}
                        </td>
                        <td>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={!unlocked || process.command === 'Sleep'}
                            onClick={() => setKillTarget(process)}
                            tooltip={
                              unlocked ? undefined : 'Unlock writes before killing a session'
                            }
                            tooltipSide="top"
                          >
                            Kill
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredProcesses.length === 0 ? (
                  <EmptyState
                    icon={<Activity size={20} />}
                    title="No matching sessions"
                    copy="Try a different filter."
                  />
                ) : null}
              </div>
            </Card>
          ) : null}

          {tab === 'slow' ? (
            <Card className="overflow-hidden">
              {snapshot.slowQuerySource === 'none' ? (
                <div className="p-4">
                  <EmptyState
                    icon={<Timer size={22} />}
                    title="Slow query data is unavailable"
                    copy={
                      snapshot.slowQueryAdvice ?? 'Enable the slow query log or performance_schema.'
                    }
                  />
                </div>
              ) : (
                <div className="overflow-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Digest</th>
                        <th>Count</th>
                        <th>Avg</th>
                        <th>Max</th>
                        <th>Rows examined</th>
                        <th>Rows sent</th>
                        <th>Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.slowQueries.map((query) => (
                        <tr key={query.digest}>
                          <td className="max-w-[420px] truncate" title={query.digestText}>
                            {query.digestText}
                          </td>
                          <td>{formatNumber(query.count)}</td>
                          <td>{formatDuration(query.avgLatencyMs)}</td>
                          <td className="text-warn">{formatDuration(query.maxLatencyMs)}</td>
                          <td>{formatNumber(query.rowsExamined)}</td>
                          <td>{formatNumber(query.rowsSent)}</td>
                          <td>{query.lastSeen ? formatRelative(query.lastSeen) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ) : null}

          {tab === 'variables' ? (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-line-soft p-3">
                <div className="relative min-w-[220px] flex-1">
                  <Search
                    size={12}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
                  />
                  <input
                    className="input input-search py-1.5 text-2xs"
                    value={variableFilter}
                    onChange={(event) => setVariableFilter(event.target.value)}
                    placeholder="Filter variables…"
                    aria-label="Filter variables"
                  />
                </div>
                <span className="text-2xs text-muted">{filteredVariables.length} variables</span>
                <span className="text-2xs text-muted">
                  updated {formatRelative(snapshot.generatedAt)}
                </span>
              </div>
              <div className="max-h-[560px] overflow-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Variable</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVariables.slice(0, 800).map(([name, value]) => (
                      <tr key={name}>
                        <td className="font-semibold text-ink-soft">{name}</td>
                        <td className="max-w-[640px] truncate" title={value}>
                          {value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredVariables.length > 800 ? (
                <div className="border-t border-line-soft px-3 py-2 text-2xs text-muted">
                  Showing first 800 of {filteredVariables.length}.
                </div>
              ) : null}
            </Card>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={Boolean(killTarget)}
        onClose={() => setKillTarget(null)}
        onConfirm={() => void killProcess()}
        title="Kill MySQL session?"
        message={
          killTarget
            ? `Terminate session ${killTarget.id} (${killTarget.user}@${killTarget.host}) running for ${killTarget.timeSeconds}s. Any open transaction will roll back.`
            : ''
        }
        confirmLabel="Kill session"
        danger
        loading={killing}
      />
    </div>
  );
}
