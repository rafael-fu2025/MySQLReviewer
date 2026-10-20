import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import type { Snippet } from '../../shared/types';
import { JsonStore } from './json-store';

interface SnippetFile {
  snippets: Snippet[];
}

const store = new JsonStore<SnippetFile>(path.join(DATA_DIR, 'snippets.json'), () => ({
  snippets: [],
}));

export interface SnippetInput {
  title: string;
  sql: string;
  tags?: string[];
}

function validate(input: SnippetInput): SnippetInput {
  const title = input.title?.trim();
  const sql = input.sql?.trim();
  if (!title) throw new AppError('VALIDATION', 'Snippet title is required.');
  if (!sql) throw new AppError('VALIDATION', 'Snippet SQL is required.');
  const tags = Array.from(
    new Set(
      (input.tags ?? [])
        .map((tag) => tag.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 10),
    ),
  );
  return { title: title.slice(0, 120), sql: sql.slice(0, 100_000), tags };
}

export async function listSnippets(): Promise<Snippet[]> {
  const file = await store.read();
  return [...file.snippets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createSnippet(input: SnippetInput): Promise<Snippet> {
  const clean = validate(input);
  const timestamp = new Date().toISOString();
  const snippet: Snippet = {
    id: crypto.randomUUID(),
    title: clean.title,
    sql: clean.sql,
    tags: clean.tags ?? [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.update((current) => ({ snippets: [snippet, ...current.snippets].slice(0, 500) }));
  return snippet;
}

export async function updateSnippet(id: string, input: SnippetInput): Promise<Snippet> {
  const clean = validate(input);
  let updated: Snippet | null = null;
  await store.update((current) => {
    const index = current.snippets.findIndex((snippet) => snippet.id === id);
    if (index < 0) throw new AppError('SNIPPET_NOT_FOUND', 'Snippet not found.', 404);
    updated = {
      ...current.snippets[index],
      title: clean.title,
      sql: clean.sql,
      tags: clean.tags ?? [],
      updatedAt: new Date().toISOString(),
    };
    const snippets = [...current.snippets];
    snippets[index] = updated;
    return { snippets };
  });
  if (!updated) throw new AppError('SNIPPET_NOT_FOUND', 'Snippet not found.', 404);
  return updated;
}

export async function deleteSnippet(id: string): Promise<void> {
  await store.update((current) => {
    if (!current.snippets.some((snippet) => snippet.id === id)) {
      throw new AppError('SNIPPET_NOT_FOUND', 'Snippet not found.', 404);
    }
    return { snippets: current.snippets.filter((snippet) => snippet.id !== id) };
  });
}
