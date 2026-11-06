import { Router } from 'express';
import { z } from 'zod';
import { clearHistory, listHistory } from '../store/history';
import { currentUser } from '../auth';
import { asyncHandler, parseQuery } from './util';

const HistoryQuery = z.object({
  profileId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const historyRouter = Router();

historyRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(HistoryQuery, req);
    res.json({
      data: await listHistory(
        query.profileId,
        query.limit ?? 100,
        // Members are scoped to their own statements; admins see everything.
        user.role === 'member' ? user.id : undefined,
      ),
    });
  }),
);

historyRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(HistoryQuery, req);
    await clearHistory(query.profileId, user.role === 'member' ? user.id : undefined);
    res.json({ data: { cleared: true } });
  }),
);
