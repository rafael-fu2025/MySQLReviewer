import path from 'node:path';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import type { AiChatMessage } from '../../shared/types';
import { JsonStore } from './json-store';

/**
 * Server-side assistant transcripts, keyed by a client-generated id that is
 * stable per context (a query tab, a practice challenge). The wire protocol
 * stays stateless — the client still sends the full history with every turn
 * — this store exists so a refresh can quietly restore what was on screen.
 *
 * Conversations are strictly personal: a record is readable only by the
 * account that wrote it, administrators included.
 */

export interface ConversationRecord {
  /** Client-generated, stable per context, e.g. `ctx-<tab id>`. */
  id: string;
  userId: string;
  profileId: string | null;
  mode: 'workspace' | 'challenge';
  title: string;
  turns: AiChatMessage[];
  createdAt: string;
  updatedAt: string;
}

interface ConversationFile {
  conversations: ConversationRecord[];
}

const store = new JsonStore<ConversationFile>(path.join(DATA_DIR, 'conversations.json'), () => ({
  conversations: [],
}));

const MAX_TURNS = 60;
const MAX_CONTENT_CHARS = 8_000;
const MAX_THINKING_CHARS = 32_000;
const MAX_TOOL_CALLS_PER_TURN = 12;
const MAX_TOOL_OUTPUT_CHARS = 2_000;
const MAX_TITLE_CHARS = 80;
const MAX_PER_USER = 50;
const MAX_TOTAL = 2_000;

/** Clamps one turn to the persisted shape — the display data, not the wire. */
function sanitizeTurn(turn: AiChatMessage): AiChatMessage {
  const clean: AiChatMessage = {
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: (turn.content ?? '').slice(0, MAX_CONTENT_CHARS),
  };
  if (turn.thinking) clean.thinking = turn.thinking.slice(0, MAX_THINKING_CHARS);
  if (turn.toolCalls?.length) {
    clean.toolCalls = turn.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN).map((call) => ({
      ...call,
      output: call.output?.slice(0, MAX_TOOL_OUTPUT_CHARS),
    }));
  }
  if (turn.usage) clean.usage = turn.usage;
  return clean;
}

/** Same charset the client generates; keeps the file inspectable. */
function assertValidId(id: string): string {
  const clean = id.trim();
  if (!clean || clean.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(clean)) {
    throw new AppError('VALIDATION', 'The conversation id is malformed.', 400);
  }
  return clean;
}

export async function saveConversationTurns(input: {
  id: string;
  userId: string;
  profileId: string | null;
  mode: 'workspace' | 'challenge';
  turns: AiChatMessage[];
}): Promise<void> {
  const id = assertValidId(input.id);
  if (!input.userId) throw new AppError('AUTH_REQUIRED', 'Sign in to save a conversation.', 401);
  if (input.turns.length > MAX_TURNS) {
    throw new AppError('VALIDATION', `A conversation holds at most ${MAX_TURNS} turns.`, 400);
  }
  const turns = input.turns.map(sanitizeTurn);
  const firstUser = turns.find((turn) => turn.role === 'user');
  const title = (firstUser?.content ?? 'Conversation')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
  const now = new Date().toISOString();

  await store.update((current) => {
    const existing = current.conversations.find((record) => record.id === id);
    if (existing && existing.userId !== input.userId) {
      // Not a leak channel: a foreign id is indistinguishable from a missing one.
      throw new AppError('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
    }
    const record: ConversationRecord = existing
      ? { ...existing, profileId: input.profileId, mode: input.mode, title, turns, updatedAt: now }
      : {
          id,
          userId: input.userId,
          profileId: input.profileId,
          mode: input.mode,
          title,
          turns,
          createdAt: now,
          updatedAt: now,
        };
    const rest = current.conversations.filter((entry) => entry.id !== id);
    // Keep at most MAX_PER_USER conversations per account, then a global cap,
    // both dropping the oldest first.
    const mineOthers = rest
      .filter((entry) => entry.userId === input.userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_PER_USER - 1);
    const keptMineIds = new Set([id, ...mineOthers.map((entry) => entry.id)]);
    const others = rest
      .filter((entry) => entry.userId !== input.userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(0, MAX_TOTAL - keptMineIds.size));
    return { conversations: [record, ...mineOthers, ...others] };
  });
}

export async function getConversation(id: string, userId: string): Promise<ConversationRecord> {
  const clean = assertValidId(id);
  const file = await store.read();
  const record = file.conversations.find((entry) => entry.id === clean);
  if (!record || record.userId !== userId) {
    throw new AppError('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
  }
  return record;
}

export async function deleteConversation(id: string, userId: string): Promise<void> {
  const clean = assertValidId(id);
  await store.update((current) => {
    const record = current.conversations.find((entry) => entry.id === clean);
    if (!record || record.userId !== userId) {
      throw new AppError('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
    }
    return { conversations: current.conversations.filter((entry) => entry.id !== clean) };
  });
}
