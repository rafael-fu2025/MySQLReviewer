import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runAudit: vi.fn(),
}));

vi.mock('../server/review/audit', () => ({ runAudit: h.runAudit }));
vi.mock('../server/db/manager', () => ({
  getCachedServerInfo: vi.fn().mockReturnValue({ version: '8.0', flavor: 'mysql' }),
  connectProfile: vi.fn(),
  shutdownPools: vi.fn(),
}));

import { isDue, tickOnce } from '../server/scheduler';
import {
  createAuditSchedule,
  deleteAuditSchedule,
  listAuditSchedules,
  markScheduleRun,
} from '../server/store/audit-schedules';
import type { AuditSchedule } from '../shared/types';

const HOUR = 3_600_000;

function schedule(overrides: Partial<AuditSchedule> = {}): AuditSchedule {
  return {
    id: 's1',
    profileId: 'p1',
    databases: ['shop'],
    intervalHours: 1,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  h.runAudit.mockReset();
  h.runAudit.mockResolvedValue({ id: 'r1', title: 'Audit' });
  // The store is a shared temp-dir file; clear it between tests.
  for (const existing of await listAuditSchedules()) {
    await deleteAuditSchedule(existing.id);
  }
});

describe('scheduler due logic', () => {
  it('is due when it has never run', () => {
    expect(isDue(schedule())).toBe(true);
  });

  it('is not due for a disabled schedule', () => {
    expect(isDue(schedule({ enabled: false }))).toBe(false);
  });

  it('is not due inside the interval', () => {
    expect(isDue(schedule({ lastRunAt: new Date(Date.now() - 0.5 * HOUR).toISOString() }))).toBe(
      false,
    );
  });

  it('is due once the interval has elapsed', () => {
    expect(isDue(schedule({ lastRunAt: new Date(Date.now() - 2 * HOUR).toISOString() }))).toBe(
      true,
    );
  });

  it('is due when the last run timestamp is unreadable', () => {
    expect(isDue(schedule({ lastRunAt: 'not-a-date' }))).toBe(true);
  });
});

describe('scheduler tick', () => {
  it('runs a due schedule through the deterministic pipeline and records success', async () => {
    await createAuditSchedule({ profileId: 'p1', databases: ['shop'], intervalHours: 1 });
    await tickOnce();

    expect(h.runAudit).toHaveBeenCalledTimes(1);
    expect(h.runAudit.mock.calls[0][0]).toMatchObject({
      profileId: 'p1',
      databases: ['shop'],
    });
    // Deterministic only: no ai option is ever passed.
    expect(h.runAudit.mock.calls[0][0].ai).toBeUndefined();

    const [stored] = await listAuditSchedules();
    expect(stored.lastStatus).toBe('ok');
    expect(stored.lastRunAt).toBeTruthy();
    expect(stored.lastError).toBeNull();
  });

  it('skips a schedule that ran inside its interval', async () => {
    const created = await createAuditSchedule({
      profileId: 'p1',
      databases: ['shop'],
      intervalHours: 1,
    });
    await markScheduleRun(created.id, 'ok', null);
    await tickOnce();
    expect(h.runAudit).not.toHaveBeenCalled();
  });

  it('records the error when the audit fails', async () => {
    h.runAudit.mockRejectedValueOnce(new Error('database offline'));
    await createAuditSchedule({ profileId: 'p1', databases: ['shop'], intervalHours: 1 });
    await tickOnce();
    const [stored] = await listAuditSchedules();
    expect(stored.lastStatus).toBe('error');
    expect(stored.lastError).toContain('database offline');
  });
});
