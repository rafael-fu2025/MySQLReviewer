import { useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileJson,
  FileText,
  Globe2,
  Loader2,
  Sparkles,
  Table2,
} from 'lucide-react';
import type { AuditReport } from '@shared/types';
import { downloadReport } from '@/lib/api';
import { formatBytes, formatDate, formatDuration, formatNumber, statusTone } from '@/lib/format';
import { GroupedFindings } from './Findings';
import { Markdown } from './Markdown';
import { Badge, Button, Card, CopyButton, ScoreRing, StatCard } from './ui';
import { cn } from '@/lib/utils';

export function AuditReportView({ report }: { report: AuditReport }) {
  const [exporting, setExporting] = useState<string | null>(null);

  const exportFormat = async (format: 'md' | 'html' | 'json'): Promise<void> => {
    setExporting(format);
    try {
      await downloadReport(report.id, format);
    } finally {
      setExporting(null);
    }
  };

  const runCoverage = report.coverage.filter((item) => item.status === 'ran').length;
  const skippedCoverage = report.coverage.length - runCoverage;

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <ScoreRing score={report.score.score} grade={report.score.grade} size={126} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="ember">audit</Badge>
              <Badge tone={report.ai ? 'info' : 'neutral'}>
                <Sparkles size={10} /> {report.ai ? 'AI summary' : 'deterministic'}
              </Badge>
              <span className="font-mono text-[10px] text-muted">
                {formatDate(report.createdAt)}
              </span>
            </div>
            <h2 className="mt-2 text-[20px] font-extrabold tracking-tight">{report.title}</h2>
            <div className="mt-1 text-[11.5px] text-muted">
              {report.profile.name} · {report.profile.user}@{report.profile.host}:
              {report.profile.port} · {formatDuration(report.durationMs)}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(['critical', 'high', 'medium', 'low', 'info'] as const)
                .filter((severity) => report.score.counts[severity] > 0)
                .map((severity) => (
                  <span key={severity} className={cn('badge', `sev-${severity}`)}>
                    {report.score.counts[severity]} {severity}
                  </span>
                ))}
              <Badge tone="neutral">{formatNumber(report.findingsTotal)} findings total</Badge>
            </div>
          </div>
          <div className="flex flex-wrap gap-1 lg:flex-col">
            <Button
              variant="secondary"
              size="sm"
              icon={
                exporting === 'md' ? <Loader2 size={12} className="spin" /> : <FileText size={12} />
              }
              onClick={() => void exportFormat('md')}
              disabled={Boolean(exporting)}
            >
              Markdown
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={
                exporting === 'html' ? <Loader2 size={12} className="spin" /> : <Globe2 size={12} />
              }
              onClick={() => void exportFormat('html')}
              disabled={Boolean(exporting)}
            >
              HTML
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={
                exporting === 'json' ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <FileJson size={12} />
                )
              }
              onClick={() => void exportFormat('json')}
              disabled={Boolean(exporting)}
            >
              JSON
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <StatCard
          label="Databases"
          value={report.stats.databases}
          sub={report.databaseScope.join(', ')}
        />
        <StatCard
          label="Tables"
          value={formatNumber(report.stats.tables)}
          icon={<Table2 size={13} />}
        />
        <StatCard label="Columns" value={formatNumber(report.stats.columns)} />
        <StatCard label="Indexes" value={formatNumber(report.stats.indexes)} />
        <StatCard label="Triggers" value={formatNumber(report.stats.triggers)} />
        <StatCard
          label="On-disk size"
          value={formatBytes(report.stats.totalBytes)}
          sub="estimated"
        />
      </div>

      {report.ai?.markdown ? (
        <Card className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Sparkles size={14} className="text-ember" />
            <div className="section-title">AI executive summary</div>
            <Badge tone="neutral" className="ml-auto">
              {report.ai.providerName} · {report.ai.model}
            </Badge>
            <CopyButton text={report.ai.markdown} label="Copy" />
          </div>
          <Markdown>{report.ai.markdown}</Markdown>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-2 border-b border-line-soft p-3">
            <CheckCircle2 size={14} className="text-mint" />
            <span className="section-title">Coverage</span>
            <Badge tone="mint" className="ml-auto">
              {runCoverage} ran
            </Badge>
            {skippedCoverage > 0 ? <Badge tone="warn">{skippedCoverage} limited</Badge> : null}
          </summary>
          <div className="overflow-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {report.coverage.map((item, index) => (
                  <tr key={`${item.check}-${index}`}>
                    <td className="text-ink-soft">{item.check}</td>
                    <td>
                      <Badge tone={statusTone(item.status) as never}>{item.status}</Badge>
                    </td>
                    <td className="max-w-[620px]">
                      {item.reason ?? '—'}
                      {item.count != null ? (
                        <span className="ml-1 text-muted">({formatNumber(item.count)})</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="section-title">Findings</div>
          <Badge className="ml-auto">{report.groups.length} rule groups</Badge>
        </div>
        <GroupedFindings groups={report.groups} />
      </Card>

      <Card className="p-4">
        <details>
          <summary className="flex cursor-pointer items-center gap-2">
            <Download size={14} className="text-muted" />
            <span className="section-title">Environment</span>
            <Badge className="ml-auto">{Object.keys(report.environment).length} values</Badge>
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(report.environment).map(([key, value]) => (
              <div key={key} className="rounded-lg border border-line-soft bg-panel-2/40 p-2.5">
                <div className="mono-label">{key}</div>
                <div className="mt-1 break-words font-mono text-[10px] text-ink-soft">
                  {value ?? 'NULL'}
                </div>
              </div>
            ))}
          </div>
        </details>
      </Card>

      <Card className="p-4">
        <details>
          <summary className="flex cursor-pointer items-center gap-2">
            <span className="section-title">Audit steps</span>
            <Badge className="ml-auto">{report.steps.length}</Badge>
          </summary>
          <div className="mt-3 flex flex-col gap-1.5">
            {report.steps.map((step) => (
              <div
                key={step.key}
                className="flex flex-wrap items-center gap-2 border-b border-line-soft py-1.5 text-[11px]"
              >
                <Badge tone={statusTone(step.status) as never}>{step.status}</Badge>
                <span className="text-ink-soft">{step.label}</span>
                {step.detail ? <span className="text-muted">— {step.detail}</span> : null}
                {step.durationMs != null ? (
                  <span className="ml-auto font-mono text-[10px] text-muted">
                    {formatDuration(step.durationMs)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      </Card>
    </div>
  );
}
