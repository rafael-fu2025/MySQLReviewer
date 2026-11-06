import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { AppError } from '../errors';
import type { AuditSchedule } from '../../shared/types';
import { JsonStore } from './json-store';

interface ScheduleFile {
  schedules: AuditSchedule[];
}

const store = new JsonStore<ScheduleFile>(path.join(DATA_DIR, 'audit-schedules.json'), () => ({
  schedules: [],
}));

const MAX_SCHEDULES = 20;

export async function listAuditSchedules(): Promise<AuditSchedule[]> {
  const file = await store.read();
  return [...file.schedules].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createAuditSchedule(input: {
  profileId: string;
  databases: string[];
  intervalHours: number;
  enabled?: boolean;
}): Promise<AuditSchedule> {
  const schedule: AuditSchedule = {
    id: crypto.randomUUID(),
    profileId: input.profileId,
    databases: input.databases,
    intervalHours: input.intervalHours,
    enabled: input.enabled ?? true,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  await store.update((current) => ({
    schedules: [schedule, ...current.schedules].slice(0, MAX_SCHEDULES),
  }));
  return schedule;
}

export async function updateAuditSchedule(
  id: string,
  patch: Partial<
    Pick<
      AuditSchedule,
      'databases' | 'intervalHours' | 'enabled' | 'lastRunAt' | 'lastStatus' | 'lastError'
    >
  >,
): Promise<AuditSchedule> {
  let updated: AuditSchedule | null = null;
  await store.update((current) => {
    const index = current.schedules.findIndex((schedule) => schedule.id === id);
    if (index < 0) throw new AppError('SCHEDULE_NOT_FOUND', 'Schedule not found.', 404);
    updated = { ...current.schedules[index], ...patch };
    const schedules = [...current.schedules];
    schedules[index] = updated;
    return { schedules };
  });
  if (!updated) throw new AppError('SCHEDULE_NOT_FOUND', 'Schedule not found.', 404);
  return updated;
}

export async function markScheduleRun(
  id: string,
  status: AuditSchedule['lastStatus'],
  error: string | null,
): Promise<void> {
  await updateAuditSchedule(id, {
    lastRunAt: new Date().toISOString(),
    lastStatus: status,
    lastError: error,
  });
}

export async function deleteAuditSchedule(id: string): Promise<void> {
  await store.update((current) => ({
    schedules: current.schedules.filter((schedule) => schedule.id !== id),
  }));
}
