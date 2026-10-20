import { Router } from 'express';
import { z } from 'zod';
import { deleteReport, getReport, listReports } from '../store/reports';
import { reportFileName, reportToHtml, reportToMarkdown } from '../review/report';
import { asyncHandler, param, parseQuery } from './util';

const ListQuery = z.object({
  kind: z.enum(['audit', 'review']).optional(),
});

const ExportQuery = z.object({
  format: z.enum(['md', 'markdown', 'html', 'json']).optional(),
});

export const reportsRouter = Router();

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
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${reportFileName(report, 'md')}"`,
    );
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
    await deleteReport(param(req, 'id'));
    res.json({ data: { deleted: true } });
  }),
);
