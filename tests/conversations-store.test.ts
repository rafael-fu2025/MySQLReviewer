import { describe, expect, it } from 'vitest';
import {
  deleteConversation,
  getConversation,
  saveConversationTurns,
} from '../server/store/conversations';
import type { AiChatMessage } from '../shared/types';

function turns(text: string): AiChatMessage[] {
  return [
    { role: 'user', content: text },
    { role: 'assistant', content: `re: ${text}` },
  ];
}

describe('conversation store', () => {
  it('saves and restores a conversation with a derived title', async () => {
    await saveConversationTurns({
      id: 'ctx-abc-1',
      userId: 'u1',
      profileId: 'p1',
      mode: 'workspace',
      turns: turns('Why is my query slow?'),
    });
    const record = await getConversation('ctx-abc-1', 'u1');
    expect(record.title).toBe('Why is my query slow?');
    expect(record.turns).toHaveLength(2);
    expect(record.mode).toBe('workspace');
  });

  it('clamps oversized content and keeps display fields', async () => {
    await saveConversationTurns({
      id: 'ctx-abc-2',
      userId: 'u1',
      profileId: null,
      mode: 'workspace',
      turns: [
        { role: 'user', content: 'x'.repeat(50_000) },
        {
          role: 'assistant',
          content: 'y'.repeat(50_000),
          thinking: 't'.repeat(50_000),
          toolCalls: [
            {
              id: 'c1',
              name: 'list_tables',
              arguments: {},
              status: 'complete',
              output: 'o'.repeat(50_000),
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      ],
    });
    const record = await getConversation('ctx-abc-2', 'u1');
    expect(record.turns[0].content.length).toBe(8_000);
    expect(record.turns[1].content.length).toBe(8_000);
    expect(record.turns[1].thinking?.length).toBe(32_000);
    expect(record.turns[1].toolCalls?.[0].output?.length).toBe(2_000);
    expect(record.turns[1].usage?.totalTokens).toBe(15);
  });

  it('scopes equal conversation ids to their owning accounts', async () => {
    await saveConversationTurns({
      id: 'ctx-abc-3',
      userId: 'u1',
      profileId: null,
      mode: 'challenge',
      turns: turns('hello'),
    });
    await expect(getConversation('ctx-abc-3', 'u2')).rejects.toMatchObject({ status: 404 });

    await saveConversationTurns({
      id: 'ctx-abc-3',
      userId: 'u2',
      profileId: null,
      mode: 'workspace',
      turns: turns('my own same-id thread'),
    });

    expect((await getConversation('ctx-abc-3', 'u1')).turns[0].content).toBe('hello');
    expect((await getConversation('ctx-abc-3', 'u2')).turns[0].content).toBe(
      'my own same-id thread',
    );
    await deleteConversation('ctx-abc-3', 'u2');
    await expect(getConversation('ctx-abc-3', 'u2')).rejects.toMatchObject({ status: 404 });
    // Deleting one composite identity leaves the other owner's copy untouched.
    expect((await getConversation('ctx-abc-3', 'u1')).turns[0].content).toBe('hello');
  });

  it('keeps at most 50 conversations per account', async () => {
    for (let index = 0; index < 52; index += 1) {
      await saveConversationTurns({
        id: `ctx-prune-${index}`,
        userId: 'u-prune',
        profileId: null,
        mode: 'workspace',
        turns: turns(`conv ${index}`),
      });
    }
    // Staggered update times: every save stamps `now`, so the earliest ids
    // are the oldest. 50 are kept: ctx-prune-51 down to ctx-prune-2.
    await expect(getConversation('ctx-prune-0', 'u-prune')).rejects.toMatchObject({ status: 404 });
    await expect(getConversation('ctx-prune-51', 'u-prune')).resolves.toMatchObject({
      id: 'ctx-prune-51',
    });
    await expect(getConversation('ctx-prune-1', 'u-prune')).rejects.toMatchObject({ status: 404 });
    await expect(getConversation('ctx-prune-2', 'u-prune')).resolves.toMatchObject({
      id: 'ctx-prune-2',
    });
    const kept = await getConversation('ctx-prune-51', 'u-prune');
    expect(kept.turns[0].content).toBe('conv 51');
  });

  it('one account reaching retention never evicts another account', async () => {
    await saveConversationTurns({
      id: 'ctx-quiet-owner',
      userId: 'u-quiet',
      profileId: null,
      mode: 'workspace',
      turns: turns('keep me'),
    });
    for (let index = 0; index < 55; index += 1) {
      await saveConversationTurns({
        id: `ctx-noisy-${index}`,
        userId: 'u-noisy',
        profileId: null,
        mode: 'workspace',
        turns: turns(`noisy ${index}`),
      });
    }
    await expect(getConversation('ctx-quiet-owner', 'u-quiet')).resolves.toMatchObject({
      id: 'ctx-quiet-owner',
    });
  });

  it('deletes on request', async () => {
    await saveConversationTurns({
      id: 'ctx-abc-del',
      userId: 'u1',
      profileId: null,
      mode: 'workspace',
      turns: turns('bye'),
    });
    await deleteConversation('ctx-abc-del', 'u1');
    await expect(getConversation('ctx-abc-del', 'u1')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects malformed ids', async () => {
    await expect(getConversation('../etc/passwd', 'u1')).rejects.toMatchObject({ status: 400 });
  });
});
