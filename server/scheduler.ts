import type { AuditSchedule } from '../shared/types';
import { connectProfile, getCachedServerInfo } from './db/manager';
import { runAudit } from './review/audit';
import { listAuditSchedules, markScheduleRun, updateAuditSchedule } from './store/audit-schedules';

/**
 * The in-process scheduler for recurring deterministic audits.
 *
 * A 60-second ticker checks the stored schedules; nothing runs unless a
 * schedule is due, and only one audit runs at a time. Scheduled runs are
 * always deterministic — `runAudit` without the `ai` option — so an
 * unattended schedule never spends provider tokens.
 */

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler(): void {
  // Tests run the server without listening; no schedules should fire there.
  if (process.env.MYLENS_NO_LISTEN === '1') return;
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** One scheduler pass; exported so tests can drive it without the timer. */
export function tickOnce(): Promise<void> {
  return tick();
}

/** A schedule is due when it has never run, or when its interval has elapsed. */
export function isDue(schedule: AuditSchedule, now = Date.now()): boolean {
  if (!schedule.enabled) return false;
  if (!schedule.lastRunAt) return true;
  const last = Date.parse(schedule.lastRunAt);
  if (Number.isNaN(last)) return true;
  return now - last >= schedule.intervalHours * 3_600_000;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const schedules = await listAuditSchedules();
    for (const schedule of schedules) {
      if (!isDue(schedule)) continue;
      await runScheduledAudit(schedule);
    }
  } catch {
    // A failing schedule store must not take the ticker down; the next tick
    // retries.
  } finally {
    running = false;
  }
}

async function runScheduledAudit(schedule: AuditSchedule): Promise<void> {
  await updateAuditSchedule(schedule.id, { lastStatus: 'running', lastError: null });
  try {
    const server =
      getCachedServerInfo(schedule.profileId) ?? (await connectProfile(schedule.profileId));
    const report = await runAudit({
      profileId: schedule.profileId,
      databases: schedule.databases,
      server,
    });
    await markScheduleRun(schedule.id, 'ok', null);
    console.log(`[mylens] scheduled audit ${schedule.id} saved report ${report.id}.`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await markScheduleRun(schedule.id, 'error', message).catch(() => undefined);
    console.error(`[mylens] scheduled audit ${schedule.id} failed: ${message}`);
  }
}
