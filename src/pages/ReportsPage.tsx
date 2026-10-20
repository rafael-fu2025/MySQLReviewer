import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Download,
  FileJson,
  FileText,
  Globe2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { ReportSummary } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { api, downloadReport } from '@/lib/api';
import { formatDate } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  PageHeader,
  ScoreRing,
  Spinner,
  Tabs,
  cn,
} from '@/components/ui';

export function ReportsPage() {
  const navigate = useNavigate();
  const toast = useAppStore((state) => state.toast);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'audit' | 'review'>('all');
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<ReportSummary | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      setReports(await api.get<ReportSummary[]>('/api/reports'));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return reports.filter((report) => {
      if (filter !== 'all' && report.kind !== filter) return false;
      if (!needle) return true;
      return `${report.title} ${report.databaseScope.join(' ')}`
        .toLowerCase()
        .includes(needle);
    });
  }, [filter, reports, search]);

  const doExport = async (
    report: ReportSummary,
    format: 'md' | 'html' | 'json',
  ): Promise<void> => {
    setExporting(`${report.id}:${format}`);
    try {
      await downloadReport(report.id, format);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setExporting(null);
    }
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
    <div className="page">
      <PageHeader
        title="Reports"
        subtitle="Saved audits and AI-assisted query reviews, exportable as Markdown, HTML, or JSON."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
            onClick={() => void load()}
            loading={loading}
          >
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          items={[
            { id: 'all', label: 'All', count: reports.length },
            {
              id: 'audit',
              label: 'Audits',
              count: reports.filter((report) => report.kind === 'audit').length,
            },
            {
              id: 'review',
              label: 'Reviews',
              count: reports.filter((report) => report.kind === 'review').length,
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
            className="input-search py-1.5 text-[11.5px]"
            placeholder="Search reports…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton h-44" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FileText size={24} />}
          title="No reports yet"
          copy="Run a full audit or save an AI review to keep it here."
          action={
            <Button variant="primary" onClick={() => navigate('/audit')}>
              Run an audit
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((report) => (
            <Card key={report.id} className="flex flex-col gap-3 p-4 hover-card">
              <div className="flex items-start gap-3">
                <ScoreRing score={report.score} grade={report.grade} size={68} stroke={6} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={report.kind === 'audit' ? 'ember' : 'info'}>
                      {report.kind}
                    </Badge>
                    {report.hasAi ? (
                      <Badge tone="info">
                        <Sparkles size={9} /> AI
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[13px] font-semibold text-ink">
                    {report.title}
                  </div>
                  <div className="mt-1 text-[9.5px] text-muted">
                    {formatDate(report.createdAt)}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted">
                <Badge tone="neutral">{report.findingsTotal} findings</Badge>
                {report.databaseScope.length > 0 ? (
                  <Badge tone="neutral">
                    {report.databaseScope.slice(0, 2).join(', ')}
                    {report.databaseScope.length > 2 ? '…' : ''}
                  </Badge>
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
                    exporting === `${report.id}:md` ? (
                      <Spinner size={11} />
                    ) : (
                      <Download size={11} />
                    )
                  }
                  onClick={() => void doExport(report, 'md')}
                  disabled={Boolean(exporting)}
                >
                  MD
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={
                    exporting === `${report.id}:html` ? (
                      <Spinner size={11} />
                    ) : (
                      <Globe2 size={11} />
                    )
                  }
                  onClick={() => void doExport(report, 'html')}
                  disabled={Boolean(exporting)}
                  title="HTML"
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
                  disabled={Boolean(exporting)}
                  title="JSON"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-danger"
                  icon={<Trash2 size={11} />}
                  onClick={() => setDeleting(report)}
                  title="Delete report"
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
        message={
          deleting
            ? `Remove “${deleting.title}” from disk. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete report"
        danger
        loading={deletingBusy}
      />
    </div>
  );
}
