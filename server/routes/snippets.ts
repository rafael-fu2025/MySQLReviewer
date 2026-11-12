import { Router } from 'express';
import { z } from 'zod';
import { createSnippet, deleteSnippet, listSnippets, updateSnippet } from '../store/snippets';
import { currentUser } from '../auth';
import { asyncHandler, param, parseBody } from './util';

const SnippetSchema = z.object({
  title: z.string().min(1).max(120),
  sql: z.string().min(1).max(100_000),
  tags: z.array(z.string().max(40)).max(10).optional(),
});

export const snippetsRouter = Router();

snippetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({
      data: await listSnippets(user.id),
    });
  }),
);

snippetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(SnippetSchema, req);
    res.status(201).json({ data: await createSnippet(body, user.id) });
  }),
);

snippetsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(SnippetSchema, req);
    res.json({
      data: await updateSnippet(param(req, 'id'), body, user.id),
    });
  }),
);

snippetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await deleteSnippet(param(req, 'id'), user.id);
    res.json({ data: { deleted: true } });
  }),
);
