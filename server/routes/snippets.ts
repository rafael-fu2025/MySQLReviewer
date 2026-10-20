import { Router } from 'express';
import { z } from 'zod';
import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  updateSnippet,
} from '../store/snippets';
import { asyncHandler, param, parseBody } from './util';

const SnippetSchema = z.object({
  title: z.string().min(1).max(120),
  sql: z.string().min(1).max(100_000),
  tags: z.array(z.string().max(40)).max(10).optional(),
});

export const snippetsRouter = Router();

snippetsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await listSnippets() });
  }),
);

snippetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(SnippetSchema, req);
    res.status(201).json({ data: await createSnippet(body) });
  }),
);

snippetsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(SnippetSchema, req);
    res.json({ data: await updateSnippet(param(req, 'id'), body) });
  }),
);

snippetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteSnippet(param(req, 'id'));
    res.json({ data: { deleted: true } });
  }),
);
