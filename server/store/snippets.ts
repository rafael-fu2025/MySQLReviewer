import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import type { Snippet } from '../../shared/types';
import { JsonStore } from './json-store';

interface SnippetFile {
  snippets: Snippet[];
}

export const MAX_SNIPPETS_PER_USER = 500;

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

/**
 * Snippets are personal for every role: callers must always name the owner.
 * Legacy ownerless entries remain quarantined rather than being attributed to
 * whichever administrator happens to sign in first.
 */
export async function listSnippets(userId: string): Promise<Snippet[]> {
  if (!userId) throw new Error('Snippet ownership is required.');
  const file = await store.read();
  const visible = file.snippets.filter((snippet) => snippet.userId === userId);
  return [...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createSnippet(input: SnippetInput, userId: string): Promise<Snippet> {
  const clean = validate(input);
  const timestamp = new Date().toISOString();
  const snippet: Snippet = {
    id: crypto.randomUUID(),
    title: clean.title,
    sql: clean.sql,
    tags: clean.tags ?? [],
    createdAt: timestamp,
    updatedAt: timestamp,
    userId,
  };
  await store.update((current) => {
    const mine = [snippet, ...current.snippets.filter((entry) => entry.userId === userId)].slice(
      0,
      MAX_SNIPPETS_PER_USER,
    );
    const others = current.snippets.filter((entry) => entry.userId !== userId);
    return { snippets: [...mine, ...others] };
  });
  return snippet;
}

export async function updateSnippet(
  id: string,
  input: SnippetInput,
  userId: string,
): Promise<Snippet> {
  if (!userId) throw new Error('Snippet ownership is required.');
  const clean = validate(input);
  let updated: Snippet | null = null;
  await store.update((current) => {
    const index = current.snippets.findIndex(
      (snippet) => snippet.id === id && snippet.userId === userId,
    );
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

export async function deleteSnippet(id: string, userId: string): Promise<void> {
  if (!userId) throw new Error('Snippet ownership is required.');
  await store.update((current) => {
    const snippet = current.snippets.find((entry) => entry.id === id && entry.userId === userId);
    if (!snippet) throw new AppError('SNIPPET_NOT_FOUND', 'Snippet not found.', 404);
    return {
      snippets: current.snippets.filter((entry) => !(entry.id === id && entry.userId === userId)),
    };
  });
}

/** Removes every snippet owned by one deleted account. */
export async function deleteSnippetsForUser(userId: string): Promise<void> {
  await store.update((current) => ({
    snippets: current.snippets.filter((entry) => entry.userId !== userId),
  }));
}

export { store as snippetsStore };
