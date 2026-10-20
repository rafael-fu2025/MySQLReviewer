import type {
  AuditReport,
  Finding,
  FindingGroup,
  StoredReviewReport,
} from '../../shared/types';
import { SEVERITY_ORDER } from '../../shared/types';

export type AnyReport = AuditReport | StoredReviewReport;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace('T', ' ').slice(0, 19);
}

function objectLabel(finding: Finding): string {
  const object = finding.object;
  if (!object) return '';
  const parts = [
    object.database && object.table ? `${object.database}.${object.table}` : object.table,
    object.column,
    object.index,
    object.user ? `'${object.user}'@'${object.host ?? ''}'` : object.host,
  ].filter(Boolean);
  return parts.join(' · ');
}

function findingLines(finding: Finding): string[] {
  const lines: string[] = [];
  lines.push(`- **[${finding.severity.toUpperCase()}] ${finding.title}** (\`${finding.ruleId}\`)`);
  if (objectLabel(finding)) lines.push(`  - Object: ${objectLabel(finding)}`);
  if (finding.line) lines.push(`  - Line: ${finding.line}`);
  lines.push(`  - ${finding.message}`);
  lines.push(`  - Recommendation: ${finding.recommendation}`);
  if (finding.evidence) lines.push(`  - Evidence: \`${finding.evidence.replace(/\n/g, ' ').slice(0, 500)}\``);
  return lines;
}

function groupMarkdown(group: FindingGroup): string[] {
  const lines: string[] = [];
  lines.push(`### [${group.severity.toUpperCase()}] ${group.title} (${group.count}×)`);
  lines.push('');
  lines.push(`Rule: \`${group.ruleId}\` · Category: ${group.category}`);
  lines.push('');
  for (const finding of group.instances.slice(0, 10)) {
    lines.push(...findingLines(finding));
  }
  if (group.count > group.instances.length) {
    lines.push(`- … and ${group.count - group.instances.length} more instance(s).`);
  }
  lines.push('');
  return lines;
}

export function reportToMarkdown(report: AnyReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.title}`);
  lines.push('');
  lines.push(`Generated: ${formatDate(report.createdAt)}`);
  if (report.profile) {
    lines.push(
      `Connection: ${report.profile.name} · ${report.profile.user}@${report.profile.host}:${report.profile.port}`,
    );
  }
  lines.push(`Databases: ${report.databaseScope.join(', ') || '(none)'}`);
  if (report.kind === 'audit') {
    lines.push(`Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
    lines.push(`Server: ${report.server?.version ?? 'unknown'} (${report.server?.flavor ?? 'unknown'})`);
  }
  lines.push('');

  const score = report.kind === 'audit' ? report.score : report.review.score;
  const total =
    report.kind === 'audit'
      ? report.findingsTotal
      : report.review.findings.length + (report.ai?.findings.length ?? 0);

  lines.push('## Score');
  lines.push('');
  lines.push(`- Score: **${score.score}/100** (grade ${score.grade})`);
  lines.push(
    `- Findings: ${score.counts.critical} critical · ${score.counts.high} high · ${score.counts.medium} medium · ${score.counts.low} low · ${score.counts.info} info · ${total} total`,
  );
  lines.push('');

  if (report.kind === 'audit' && report.ai?.markdown) {
    lines.push('## AI executive summary');
    lines.push('');
    lines.push(report.ai.markdown);
    lines.push('');
  }

  if (report.kind === 'audit') {
    lines.push('## Environment');
    lines.push('');
    for (const [key, value] of Object.entries(report.environment)) {
      lines.push(`- ${key}: ${value ?? 'null'}`);
    }
    lines.push('');
    lines.push('## Coverage');
    lines.push('');
    for (const item of report.coverage) {
      lines.push(
        `- ${item.check}: **${item.status}**${item.reason ? ` — ${item.reason}` : ''}${item.count != null ? ` (${item.count})` : ''}`,
      );
    }
    lines.push('');
    lines.push('## Statistics');
    lines.push('');
    for (const [key, value] of Object.entries(report.stats)) {
      lines.push(`- ${key}: ${value}`);
    }
    lines.push('');
    lines.push('## Findings');
    lines.push('');
    if (report.groups.length === 0) {
      lines.push('No findings.');
      lines.push('');
    } else {
      const sorted = [...report.groups].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
      );
      for (const group of sorted) {
        lines.push(...groupMarkdown(group));
      }
    }
    lines.push('## Audit steps');
    lines.push('');
    for (const step of report.steps) {
      lines.push(
        `- ${step.label}: ${step.status}${step.detail ? ` — ${step.detail}` : ''}${step.durationMs != null ? ` (${step.durationMs} ms)` : ''}`,
      );
    }
    lines.push('');
  } else {
    lines.push('## SQL');
    lines.push('');
    lines.push('```sql');
    lines.push(report.sql);
    lines.push('```');
    lines.push('');
    lines.push('## Findings');
    lines.push('');
    if (report.review.findings.length === 0) {
      lines.push('No deterministic findings.');
    } else {
      for (const finding of report.review.findings) {
        lines.push(...findingLines(finding));
      }
    }
    lines.push('');
    if (report.review.suggestions.length > 0) {
      lines.push('## Index suggestions');
      lines.push('');
      for (const suggestion of report.review.suggestions) {
        lines.push(
          `- \`${suggestion.database}.${suggestion.table}\` (${suggestion.columns.join(', ')}): ${suggestion.reason}`,
        );
        lines.push('  ```sql');
        lines.push(`  ${suggestion.statement}`);
        lines.push('  ```');
      }
      lines.push('');
    }
    if (report.ai) {
      lines.push('## AI review');
      lines.push('');
      lines.push(`Provider: ${report.ai.providerName} · model: ${report.ai.model} · verdict: ${report.ai.verdict}`);
      lines.push('');
      lines.push(report.ai.markdown);
      lines.push('');
      if (report.ai.findings.length > 0) {
        lines.push('### AI findings');
        lines.push('');
        for (const finding of report.ai.findings) {
          lines.push(...findingLines(finding));
        }
        lines.push('');
      }
      if (report.ai.rewrite) {
        lines.push('### Suggested rewrite');
        lines.push('');
        lines.push('```sql');
        lines.push(report.ai.rewrite.sql);
        lines.push('```');
        lines.push('');
        lines.push(report.ai.rewrite.explanation);
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('Generated by MyLens — local MySQL review studio. Verify recommendations before applying them.');
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let inList = false;

  const closeList = (): void => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      closeList();
      out.push('');
      continue;
    }
    if (line.startsWith('### ')) {
      closeList();
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      closeList();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return out.join('\n');
}

function severityClass(severity: string): string {
  return ['critical', 'high', 'medium', 'low', 'info'].includes(severity)
    ? `sev-${severity}`
    : 'sev-info';
}

function findingHtml(finding: Finding): string {
  return `<div class="finding ${severityClass(finding.severity)}">
  <div class="finding-head"><span class="pill">${escapeHtml(finding.severity.toUpperCase())}</span><strong>${escapeHtml(finding.title)}</strong><code>${escapeHtml(finding.ruleId)}</code></div>
  ${objectLabel(finding) ? `<div class="meta">${escapeHtml(objectLabel(finding))}${finding.line ? ` · line ${finding.line}` : ''}</div>` : ''}
  <p>${escapeHtml(finding.message)}</p>
  <p class="rec"><strong>Recommendation:</strong> ${escapeHtml(finding.recommendation)}</p>
  ${finding.evidence ? `<pre class="evidence">${escapeHtml(finding.evidence.slice(0, 1000))}</pre>` : ''}
</div>`;
}

function groupHtml(group: FindingGroup): string {
  const instances = group.instances.slice(0, 15).map(findingHtml).join('\n');
  const more =
    group.count > group.instances.length
      ? `<p class="meta">… and ${group.count - group.instances.length} more instance(s).</p>`
      : '';
  return `<section class="group">
  <h3><span class="pill ${severityClass(group.severity)}">${escapeHtml(group.severity.toUpperCase())}</span> ${escapeHtml(group.title)} <span class="count">${group.count}×</span></h3>
  <div class="meta">${escapeHtml(group.ruleId)} · ${escapeHtml(group.category)}</div>
  ${instances}
  ${more}
</section>`;
}

export function reportToHtml(report: AnyReport): string {
  const score = report.kind === 'audit' ? report.score : report.review.score;
  const total =
    report.kind === 'audit'
      ? report.findingsTotal
      : report.review.findings.length + (report.ai?.findings.length ?? 0);

  let body = '';
  body += `<header><div class="brand">MyLens · MySQL Review Studio</div><h1>${escapeHtml(report.title)}</h1>`;
  body += `<div class="meta">Generated ${escapeHtml(formatDate(report.createdAt))}`;
  if (report.profile) {
    body += ` · ${escapeHtml(report.profile.name)} (${escapeHtml(report.profile.user)}@${escapeHtml(report.profile.host)}:${report.profile.port})`;
  }
  body += ` · Databases: ${escapeHtml(report.databaseScope.join(', ') || '(none)')}</div></header>`;

  body += `<section class="score"><div class="score-value">${score.score}</div><div><div class="grade">Grade ${escapeHtml(score.grade)}</div><div class="meta">${total} findings · ${score.counts.critical} critical · ${score.counts.high} high · ${score.counts.medium} medium · ${score.counts.low} low · ${score.counts.info} info</div></div></section>`;

  if (report.kind === 'audit' && report.ai?.markdown) {
    body += `<section><h2>AI executive summary</h2><div class="markdown">${markdownToHtml(report.ai.markdown)}</div></section>`;
  }

  if (report.kind === 'audit') {
    body += `<section><h2>Environment</h2><table>`;
    for (const [key, value] of Object.entries(report.environment)) {
      body += `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value ?? 'null'))}</td></tr>`;
    }
    body += `</table></section>`;

    body += `<section><h2>Coverage</h2><table><thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead><tbody>`;
    for (const item of report.coverage) {
      body += `<tr><td>${escapeHtml(item.check)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.reason ?? '')}${item.count != null ? ` (${item.count})` : ''}</td></tr>`;
    }
    body += `</tbody></table></section>`;

    body += `<section><h2>Findings</h2>`;
    if (report.groups.length === 0) {
      body += `<p>No findings.</p>`;
    } else {
      const sorted = [...report.groups].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
      );
      body += sorted.map(groupHtml).join('\n');
    }
    body += `</section>`;
  } else {
    body += `<section><h2>SQL</h2><pre class="sql">${escapeHtml(report.sql)}</pre></section>`;
    body += `<section><h2>Deterministic findings</h2>`;
    body += report.review.findings.length
      ? report.review.findings.map(findingHtml).join('\n')
      : '<p>No deterministic findings.</p>';
    body += `</section>`;

    if (report.review.suggestions.length > 0) {
      body += `<section><h2>Index suggestions</h2>`;
      for (const suggestion of report.review.suggestions) {
        body += `<div class="finding"><div class="finding-head"><strong>${escapeHtml(suggestion.table)}</strong><code>${escapeHtml(suggestion.confidence)}</code></div><p>${escapeHtml(suggestion.reason)}</p><pre class="sql">${escapeHtml(suggestion.statement)}</pre></div>`;
      }
      body += `</section>`;
    }

    if (report.ai) {
      body += `<section><h2>AI review</h2><div class="meta">${escapeHtml(report.ai.providerName)} · ${escapeHtml(report.ai.model)} · verdict ${escapeHtml(report.ai.verdict)}</div><div class="markdown">${markdownToHtml(report.ai.markdown)}</div>`;
      if (report.ai.findings.length) {
        body += `<h3>AI findings</h3>${report.ai.findings.map(findingHtml).join('\n')}`;
      }
      if (report.ai.rewrite) {
        body += `<h3>Suggested rewrite</h3><pre class="sql">${escapeHtml(report.ai.rewrite.sql)}</pre><p>${escapeHtml(report.ai.rewrite.explanation)}</p>`;
      }
      body += `</section>`;
    }
  }

  body += `<footer>Generated by MyLens. Verify recommendations before applying them.</footer>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f6f5f1;color:#171a20;font:15px/1.55 "Segoe UI",system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:40px 28px 80px}
header{background:linear-gradient(135deg,#0f1117,#1a1e28);color:#f5f2ea;padding:32px;border-radius:16px}
.brand{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#ff9a57;font-weight:700}
h1{font-size:28px;line-height:1.2;margin:12px 0 8px}
h2{font-size:20px;margin:34px 0 12px;border-bottom:1px solid #ddd8cc;padding-bottom:8px}
h3{font-size:16px;margin:22px 0 8px}
.meta{color:#6b7280;font-size:13px}
header .meta{color:#b6bdc9}
.score{display:flex;align-items:center;gap:22px;background:#fff;border:1px solid #e4e0d6;border-radius:16px;padding:22px 26px;margin-top:24px}
.score-value{font:800 54px/1 "Cascadia Code",Consolas,monospace;color:#c25512}
.grade{font-weight:700;font-size:18px}
section{background:#fff;border:1px solid #e4e0d6;border-radius:14px;padding:20px 24px;margin-top:18px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #eee9df;vertical-align:top}
th{color:#4b5563;font-weight:600;width:38%}
.group{border-top:1px solid #eee9df;padding-top:12px;margin-top:16px}
.group:first-of-type{border-top:0}
.finding{border-left:4px solid #9ca3af;background:#faf9f6;border-radius:8px;padding:12px 14px;margin:10px 0}
.finding-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.finding p{margin:8px 0 0}
.rec{color:#374151}
.pill{display:inline-block;border-radius:999px;padding:2px 8px;font-size:10px;font-weight:800;letter-spacing:.08em;background:#e5e7eb;color:#374151}
.pill.sev-critical{background:#7f1d1d;color:#fff}
.pill.sev-high{background:#dc2626;color:#fff}
.pill.sev-medium{background:#f59e0b;color:#1f2937}
.pill.sev-low{background:#0d9488;color:#fff}
.pill.sev-info{background:#64748b;color:#fff}
.finding.sev-critical{border-left-color:#7f1d1d}
.finding.sev-high{border-left-color:#dc2626}
.finding.sev-medium{border-left-color:#f59e0b}
.finding.sev-low{border-left-color:#0d9488}
.finding.sev-info{border-left-color:#64748b}
code{font-family:"Cascadia Code",Consolas,monospace;font-size:12px;background:#f0ede5;padding:1px 5px;border-radius:4px}
pre{overflow:auto;font-family:"Cascadia Code",Consolas,monospace;font-size:12px;background:#12151c;color:#e7ecf3;padding:14px;border-radius:10px;line-height:1.5}
pre.evidence{background:#f0ede5;color:#333;font-size:11px}
.count{color:#6b7280;font-size:13px;font-weight:500}
.markdown p{margin:8px 0}
.markdown ul{margin:8px 0 8px 20px;padding:0}
footer{margin-top:30px;color:#6b7280;font-size:12px;text-align:center}
@media print{body{background:#fff}main{padding:0;max-width:none}section,header,.score{box-shadow:none}header{background:#fff;color:#111;border:1px solid #ddd}header .meta{color:#555}h2{page-break-after:avoid}.finding{page-break-inside:avoid}}
</style></head><body><main>${body}</main></body></html>`;
}

export function reportFileName(report: AnyReport, extension: 'md' | 'html' | 'json'): string {
  const safe = report.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mylens-${report.kind}-${safe}.${extension}`;
}
