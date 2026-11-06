import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileJson, FileText, Globe2, RefreshCw, Search, Trash2, XCircle } from 'lucide-react';
import type { ReportSummary } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { api, downloadReport } from '@/lib/api';
import { formatDate } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  PageHeader,
  ScoreRing,
  Spinner,
  Tabs,
} from '@/components/ui';
import { cn } from '@/lib/utils';

/** Export is per report, so only that report's buttons go busy. */
function isExporting(exporting: string | null, reportId: string): boolean {
  return exporting?.startsWith(`${reportId}:`) ?? false;
}

export function ReportsPage() {
  const navigate = useNavigate();
  const toast = useAppStore((state) => state.toast);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  // Bumping the request counter reloads the list; the loading flag and the
  // error are derived from the request the state belongs to.
  const [loadRequest, setLoadRequest] = useState(0);
  const [loadState, setLoadState] = useState<{ request: number; error: string | null } | null>(
    null,
  );
  const loading = loadState === null || loadState.request !== loadRequest;
  const loadError = loadState?.request === loadRequest ? loadState.error : null;
  const [filter, setFilter] = useState<'all' | 'audit' | 'review'>('all');
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<ReportSummary | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const refresh = (): void => {
    setLoadRequest((value) => value + 1);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .get<ReportSummary[]>('/api/reports')
      .then((result) => {
        if (cancelled) return;
        setReports(result);
        setLoadState({ request: loadRequest, error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setReports([]);
        setLoadState({
          request: loadRequest,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [loadRequest]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return reports.filter((report) => {
      if (filter !== 'all' && report.kind !== filter) return false;
      if (!needle) return true;
      return `${report.title} ${report.databaseScope.join(' ')}`.toLowerCase().includes(needle);
    });
  }, [filter, reports, search]);

  const doExport = async (report: ReportSummary, format: 'md' | 'html' | 'json'): Promise<void> => {
    setExporting(`${report.id}:${format}`);
    try {
      await downloadReport(report.id, format);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setExporting(null);
    }
  };

  const clearFilters = (): void => {
    setFilter('all');
    setSearch('');
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await api.del(`/api/reports/${encodeURIComponent(deleting.id)}`);
      setReports((current) => current.filter((report) => report.id !== deleting.id));
      toast('Report deleted.', 'success');
      setDeleting(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <div className={cn('page', reports.length === 0 && !loading && !loadError && 'page-centered')}>
      <PageHeader
        title="Reports"
        subtitle="Saved audits and query reviews."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
            onClick={refresh}
            loading={loading}
          >
            Refresh
          </Button>
        }
      />

      {reports.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            items={[
              { id: 'all', label: 'All', count: reports.length || undefined },
              {
                id: 'audit',
                label: 'Audits',
                count: reports.filter((report) => report.kind === 'audit').length || undefined,
              },
              {
                id: 'review',
                label: 'Reviews',
                count: reports.filter((report) => report.kind === 'review').length || undefined,
              },
            ]}
            value={filter}
            onChange={setFilter}
          />
          <div className="relative ml-auto min-w-[240px]">
            <Search
              size={12}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            />
            <Input
              className="input-search py-1.5 text-2xs"
              placeholder="Search reports…"
              aria-label="Search reports"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton h-44" />
          ))}
        </div>
      ) : loadError ? (
        <Card className="p-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-danger/30 bg-danger/10 text-danger">
              <XCircle size={22} />
            </div>
            <div className="text-base font-bold">Reports could not be loaded</div>
            <div className="max-w-md text-xs text-muted">{loadError}</div>
            <Button variant="secondary" icon={<RefreshCw size={12} />} onClick={refresh}>
              Retry
            </Button>
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <div className="empty-anchor">
          {reports.length === 0 ? (
            <EmptyState
              icon={<FileText size={24} />}
              title="No reports yet"
              action={
                <Button variant="primary" onClick={() => navigate('/audit')}>
                  Run audit
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Search size={24} />}
              title="No reports match this filter"
              action={
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((report) => (
            <Card key={report.id} className="flex flex-col gap-3 p-4 hover-card">
              <div className="flex items-start gap-3">
                <ScoreRing score={report.score} grade={report.grade} size={68} stroke={6} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mono-label">
                      {report.kind === 'audit' ? 'Audit' : 'Review'}
                    </span>
                    {report.hasAi ? <span className="mono-label">AI summary</span> : null}
                  </div>
                  <div className="mt-1 line-clamp-2 text-sm font-semibold text-ink">
                    {report.title}
                  </div>
                  <div className="mt-1 text-2xs text-muted">{formatDate(report.createdAt)}</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
                <span>{report.findingsTotal} findings</span>
                {report.databaseScope.length > 0 ? (
                  <span>
                    {report.databaseScope.slice(0, 2).join(', ')}
                    {report.databaseScope.length > 2 ? '…' : ''}
                  </span>
                ) : null}
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-line-soft pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate(`/reports/${report.id}`)}
                >
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={
                    exporting === `${report.id}:md` ? <Spinner size={11} /> : <FileText size={11} />
                  }
                  onClick={() => void doExport(report, 'md')}
                  disabled={isExporting(exporting, report.id)}
                  aria-label="Export as Markdown"
                  tooltip="Markdown"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={
                    exporting === `${report.id}:html` ? <Spinner size={11} /> : <Globe2 size={11} />
                  }
                  onClick={() => void doExport(report, 'html')}
                  disabled={isExporting(exporting, report.id)}
                  aria-label="Export as HTML"
                  tooltip="HTML"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={
                    exporting === `${report.id}:json` ? (
                      <Spinner size={11} />
                    ) : (
                      <FileJson size={11} />
                    )
                  }
                  onClick={() => void doExport(report, 'json')}
                  disabled={isExporting(exporting, report.id)}
                  aria-label="Export as JSON"
                  tooltip="JSON"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  tooltipClassName="ml-auto"
                  icon={<Trash2 size={11} />}
                  onClick={() => setDeleting(report)}
                  aria-label="Delete report"
                  tooltip="Delete report"
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title="Delete report?"
        message={deleting ? `Remove “${deleting.title}” from disk. This cannot be undone.` : ''}
        confirmLabel="Delete report"
        danger
        loading={deletingBusy}
      />
    </div>
  );
}
