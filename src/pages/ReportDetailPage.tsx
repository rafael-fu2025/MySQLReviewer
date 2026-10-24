import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileJson, FileText, Globe2, Sparkles, Wand2, XCircle } from 'lucide-react';
import type { AuditReport, StoredReviewReport } from '@shared/types';
import { api, downloadReport } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { AuditReportView } from '@/components/AuditReportView';
import { FindingCard, FindingsHint, FindingsList } from '@/components/Findings';
import { Markdown } from '@/components/Markdown';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  PageHeader,
  ScoreRing,
  Spinner,
} from '@/components/ui';
import { cn } from '@/lib/utils';

function CodeBlock({ text, className }: { text: string; className?: string }) {
  return <pre className={cn('code-block', className)}>{text}</pre>;
}

function ReviewReportView({ report }: { report: StoredReviewReport }) {
  const [exporting, setExporting] = useState<string | null>(null);
  const review = report.review;

  const exportFormat = async (format: 'md' | 'html' | 'json'): Promise<void> => {
    setExporting(format);
    try {
      await downloadReport(report.id, format);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <ScoreRing score={review.score.score} grade={review.score.grade} size={116} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">Review</Badge>
              {report.ai ? (
                <Badge tone="info">
                  <Sparkles size={9} /> AI summary
                </Badge>
              ) : null}
              <span className="font-mono text-[10px] text-muted">
                {formatDate(report.createdAt)}
              </span>
            </div>
            <h2 className="mt-2 text-[19px] font-extrabold tracking-tight">{report.title}</h2>
            <div className="mt-1 text-[11px] text-muted">
              {report.profile
                ? `${report.profile.name} · ${report.profile.user}@${report.profile.host}:${report.profile.port}`
                : 'No connection snapshot'}
              {report.databaseScope.length ? ` · ${report.databaseScope.join(', ')}` : ''}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(['critical', 'high', 'medium', 'low', 'info'] as const)
                .filter((severity) => review.score.counts[severity] > 0)
                .map((severity) => (
                  <span key={severity} className={cn('badge', `sev-${severity}`)}>
                    {review.score.counts[severity]} {severity}
                  </span>
                ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-1 lg:flex-col">
            <Button
              variant="secondary"
              size="sm"
              icon={exporting === 'md' ? <Spinner size={12} /> : <FileText size={12} />}
              onClick={() => void exportFormat('md')}
            >
              Markdown
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={exporting === 'html' ? <Spinner size={12} /> : <Globe2 size={12} />}
              onClick={() => void exportFormat('html')}
            >
              HTML
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={exporting === 'json' ? <Spinner size={12} /> : <FileJson size={12} />}
              onClick={() => void exportFormat('json')}
            >
              JSON
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="section-title mb-2">Statement</div>
        <CodeBlock text={report.sql} className="max-h-72" />
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted">
          <Badge tone="neutral">
            {review.statements.length} statement{review.statements.length === 1 ? '' : 's'}
          </Badge>
          {review.context.tables.length > 0 ? (
            <span>
              Context tables: {review.context.tables.map((table) => table.table).join(', ')}
            </span>
          ) : null}
          {review.context.truncated ? <Badge tone="warn">context truncated</Badge> : null}
        </div>
      </Card>

      {review.warnings.length > 0 ? (
        <Card className="p-4">
          <div className="section-title mb-2">Warnings</div>
          {review.warnings.map((warning, index) => (
            <div key={index} className="text-[11.5px] text-warn">
              {warning}
            </div>
          ))}
        </Card>
      ) : null}

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="section-title">Deterministic findings</div>
          <Badge className="ml-auto">{review.findings.length}</Badge>
        </div>
        <FindingsHint findings={review.findings} />
        <FindingsList
          findings={review.findings}
          emptyTitle="No deterministic findings"
          emptyCopy="The rule engine did not find a problem in this statement."
        />
      </Card>

      {review.suggestions.length > 0 ? (
        <Card className="p-4">
          <div className="section-title mb-2">Index suggestions</div>
          <div className="flex flex-col gap-2">
            {review.suggestions.map((suggestion) => (
              <div key={suggestion.statement} className="finding sev-info p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">{suggestion.confidence}</Badge>
                  <span className="font-mono text-[11px] text-ink">
                    {suggestion.database}.{suggestion.table} ({suggestion.columns.join(', ')})
                  </span>
                </div>
                <div className="finding-message">{suggestion.reason}</div>
                <CodeBlock text={suggestion.statement} className="mt-2 text-[10.5px]" />
                <div className="mt-1 flex justify-end">
                  <CopyButton text={suggestion.statement} label="Copy ALTER" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {report.ai ? (
        <Card className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Sparkles size={14} className="text-ember" />
            <div className="section-title">AI summary</div>
            <Badge tone="neutral" className="ml-auto">
              {report.ai.providerName} · {report.ai.model} · {report.ai.verdict}
            </Badge>
            <CopyButton text={report.ai.markdown} label="Copy" />
          </div>
          {report.ai.markdown ? <Markdown>{report.ai.markdown}</Markdown> : null}
          {report.ai.findings.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              <div className="section-title">AI findings</div>
              {report.ai.findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
            </div>
          ) : null}
          {report.ai.rewrite ? (
            <div className="mt-3 rounded-xl border border-line-soft bg-panel-2/40 p-3">
              <div className="flex items-center gap-2">
                <Wand2 size={13} className="text-ember" />
                <span className="text-[12px] font-semibold">Suggested rewrite</span>
                <CopyButton text={report.ai.rewrite.sql} label="Copy" className="ml-auto" />
              </div>
              <CodeBlock text={report.ai.rewrite.sql} className="mt-2" />
              <div className="mt-2 text-[11px] text-muted">{report.ai.rewrite.explanation}</div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

export function ReportDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  // The response is tagged with the report id it was fetched for, so a report
  // for one id can never render under another id's URL.
  const [reportState, setReportState] = useState<{
    id: string;
    report: AuditReport | StoredReviewReport | null;
    error: string | null;
  } | null>(null);
  const report = reportState && reportState.id === id ? reportState.report : null;
  const error = reportState && reportState.id === id ? reportState.error : null;
  const missingId = !id;
  const loading = Boolean(id) && (!reportState || reportState.id !== id);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .get<AuditReport | StoredReviewReport>(`/api/reports/${encodeURIComponent(id)}`)
      .then((result) => {
        if (cancelled) return;
        setReportState({ id, report: result, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setReportState({
          id,
          report: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="page">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Spinner size={14} /> Loading report…
        </div>
      </div>
    );
  }

  if (missingId) {
    return (
      <div className="page">
        <PageHeader title="Report" />
        <EmptyState
          icon={<XCircle size={24} />}
          title="Report not found"
          action={
            <Button variant="secondary" onClick={() => navigate('/reports')}>
              Back to reports
            </Button>
          }
        />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="page">
        <PageHeader title="Report" />
        <EmptyState
          icon={<XCircle size={24} />}
          title="Report unavailable"
          copy={error ?? 'The report could not be loaded.'}
          action={
            <Button variant="secondary" onClick={() => navigate('/reports')}>
              Back to reports
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft size={13} />}
          onClick={() => navigate('/reports')}
        >
          Back to reports
        </Button>
        <span className="font-mono text-[10px] text-muted">{report.id}</span>
        <Badge tone={report.kind === 'audit' ? 'ember' : 'info'} className="ml-auto">
          {report.kind === 'audit' ? 'Audit' : 'Review'}
        </Badge>
      </div>
      {report.kind === 'audit' ? (
        <AuditReportView report={report} />
      ) : (
        <ReviewReportView report={report} />
      )}
    </div>
  );
}
