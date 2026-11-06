import { Router } from 'express';
import { z } from 'zod';
import { deleteReport, getReport, listReports } from '../store/reports';
import { reportFileName, reportToHtml, reportToMarkdown } from '../review/report';
import { logActivity } from '../store/activity';
import { currentUser, requireAdmin } from '../auth';
import { asyncHandler, param, parseQuery } from './util';

const ListQuery = z.object({
  kind: z.enum(['audit', 'review']).optional(),
});

const ExportQuery = z.object({
  format: z.enum(['md', 'markdown', 'html', 'json']).optional(),
});

export const reportsRouter = Router();

// Reports are admin artifacts: audits are admin-only, and review saves are
// gated at creation. Members never see this router.
reportsRouter.use((req, _res, next) => {
  try {
    requireAdmin(req);
    next();
  } catch (error) {
    next(error);
  }
});

reportsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseQuery(ListQuery, req);
    const reports = await listReports();
    res.json({
      data: query.kind ? reports.filter((report) => report.kind === query.kind) : reports,
    });
  }),
);

reportsRouter.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const query = parseQuery(ExportQuery, req);
    const report = await getReport(id);
    const format = query.format ?? 'md';
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportFileName(report, 'json')}"`,
      );
      res.send(JSON.stringify(report, null, 2));
      return;
    }
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportFileName(report, 'html')}"`,
      );
      res.send(reportToHtml(report));
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(report, 'md')}"`);
    res.send(reportToMarkdown(report));
  }),
);

reportsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ data: await getReport(param(req, 'id')) });
  }),
);

reportsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = param(req, 'id');
    const report = await getReport(id);
    await deleteReport(id);
    await logActivity({
      userId: user.id,
      username: user.username,
      action: 'report-delete',
      profileId: report.profile?.id,
      detail: `"${report.title}" deleted`,
    });
    res.json({ data: { deleted: true } });
  }),
);
