import { describe, expect, it } from 'vitest';
import type { ActivityAction, ActivityEntry } from '../shared/types';
import {
  MAX_ORDINARY_ENTRIES_PER_USER,
  MAX_RESERVED_ENTRIES_PER_USER,
  retainActivityEntries,
} from '../server/store/activity';

function entry(id: string, userId: string, action: ActivityAction, index: number): ActivityEntry {
  return {
    id,
    userId,
    username: userId,
    action,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

describe('activity retention isolation', () => {
  it('a noisy ordinary user cannot evict another user ordinary evidence', () => {
    const protectedB = entry('b-query', 'user-b', 'query', 0);
    const noisyA = Array.from({ length: MAX_ORDINARY_ENTRIES_PER_USER + 100 }, (_, index) =>
      entry(`a-query-${index}`, 'user-a', 'query', index + 1),
    );

    const retained = retainActivityEntries([protectedB, ...noisyA]);

    expect(retained.some((item) => item.id === protectedB.id)).toBe(true);
    expect(retained.filter((item) => item.userId === 'user-a')).toHaveLength(
      MAX_ORDINARY_ENTRIES_PER_USER,
    );
  });

  it('ordinary activity cannot erase reserved admin or security evidence', () => {
    const adminDelete = entry('admin-delete', 'admin', 'admin-user-delete', 0);
    const failedBoundary = entry('unlock-boundary', 'member', 'unlock', 1);
    const noisyQueries = Array.from({ length: MAX_ORDINARY_ENTRIES_PER_USER + 500 }, (_, index) =>
      entry(`query-${index}`, 'noisy-user', 'query', index + 2),
    );

    const retained = retainActivityEntries([adminDelete, failedBoundary, ...noisyQueries]);

    expect(retained.some((item) => item.id === adminDelete.id)).toBe(true);
    expect(retained.some((item) => item.id === failedBoundary.id)).toBe(true);
    expect(retained.filter((item) => item.action === 'query').length).toBeLessThanOrEqual(
      MAX_ORDINARY_ENTRIES_PER_USER,
    );
  });

  it('a reserved-event flood cannot erase another user or admin evidence', () => {
    const protectedMember = entry('member-unlock', 'user-b', 'unlock', 0);
    const protectedAdmin = entry('admin-delete', 'admin', 'admin-user-delete', 1);
    const noisyReserved = Array.from({ length: MAX_RESERVED_ENTRIES_PER_USER + 100 }, (_, index) =>
      entry(`a-login-${index}`, 'user-a', 'login', index + 2),
    );

    const retained = retainActivityEntries([protectedMember, protectedAdmin, ...noisyReserved]);

    expect(retained.some((item) => item.id === protectedMember.id)).toBe(true);
    expect(retained.some((item) => item.id === protectedAdmin.id)).toBe(true);
    expect(retained.filter((item) => item.userId === 'user-a')).toHaveLength(
      MAX_RESERVED_ENTRIES_PER_USER,
    );
  });

  it('bounds every user reserved partition independently newest-first', () => {
    const reservedA = Array.from({ length: MAX_RESERVED_ENTRIES_PER_USER + 2 }, (_, index) =>
      entry(`admin-a-${index}`, 'admin-a', 'admin-user-update', index),
    );
    const reservedB = Array.from({ length: MAX_RESERVED_ENTRIES_PER_USER + 2 }, (_, index) =>
      entry(`admin-b-${index}`, 'admin-b', 'admin-user-update', index + 10_000),
    );

    const retained = retainActivityEntries([...reservedA, ...reservedB]);

    expect(retained.filter((item) => item.userId === 'admin-a')).toHaveLength(
      MAX_RESERVED_ENTRIES_PER_USER,
    );
    expect(retained.filter((item) => item.userId === 'admin-b')).toHaveLength(
      MAX_RESERVED_ENTRIES_PER_USER,
    );
    expect(retained.some((item) => item.id === 'admin-a-0')).toBe(false);
    expect(retained.some((item) => item.id === 'admin-b-0')).toBe(false);
    expect(
      retained.some((item) => item.id === `admin-a-${MAX_RESERVED_ENTRIES_PER_USER + 1}`),
    ).toBe(true);
    expect(
      retained.some((item) => item.id === `admin-b-${MAX_RESERVED_ENTRIES_PER_USER + 1}`),
    ).toBe(true);
  });
});
