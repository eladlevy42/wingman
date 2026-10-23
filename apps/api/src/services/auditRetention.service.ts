import { prisma } from "@wingman/database";
import { positiveIntFromEnv } from "../middleware/rateLimit";
import { isOrchestrationRunning } from "./orchestration.service";

// Retention and rollups for the audit tables (docs/adr/0038, #555).
//
// Two jobs that have to happen in this order: roll a day's raw rows up into
// permanent counters, and only then let those raw rows be deleted. Reversed,
// the deletion silently takes the month-over-month statistics with it.

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_SWEEP_INTERVAL_MINUTES = 24 * 60;

export function retentionDays(): number {
  return positiveIntFromEnv("AUDIT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
}

export function sweepIntervalMs(): number {
  return (
    positiveIntFromEnv("AUDIT_SWEEP_INTERVAL_MINUTES", DEFAULT_SWEEP_INTERVAL_MINUTES) * 60_000
  );
}

/** The UTC day a timestamp belongs to, as YYYY-MM-DD. */
export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Midnight UTC `days` before `now` — the cutoff rows older than are deleted. */
export function cutoffFor(now: Date, days: number): Date {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
}

interface Bucket {
  bucket: string;
  eventType?: string;
  actor?: string;
  model?: string;
  count: number;
  costUsd: number;
  durationMs: number;
}

/**
 * Recomputes the rollup for every day with raw rows at or before `through`.
 *
 * Idempotent by construction: each bucket is recomputed from the raw rows and
 * written with `upsert`, so running twice over the same day produces the same
 * counters rather than doubling them. That matters because the sweep runs on a
 * timer with no memory of what it has already done, and a restart mid-sweep
 * must not corrupt a month's numbers.
 */
export async function rollUpThrough(through: Date): Promise<{ days: number; buckets: number }> {
  const [events, calls] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { createdAt: { lte: through } },
      select: { type: true, createdAt: true },
    }),
    prisma.agentCall.findMany({
      where: { createdAt: { lte: through } },
      select: { actor: true, model: true, costUsd: true, durationMs: true, createdAt: true },
    }),
  ]);

  // day -> kind -> bucket
  const byDay = new Map<string, { event: Map<string, Bucket>; agent_call: Map<string, Bucket> }>();
  const dayOf = (day: string) => {
    let entry = byDay.get(day);
    if (!entry) {
      entry = { event: new Map(), agent_call: new Map() };
      byDay.set(day, entry);
    }
    return entry;
  };

  for (const event of events) {
    const buckets = dayOf(dayKey(event.createdAt)).event;
    const existing = buckets.get(event.type);
    if (existing) existing.count += 1;
    else
      buckets.set(event.type, {
        bucket: event.type,
        eventType: event.type,
        count: 1,
        costUsd: 0,
        durationMs: 0,
      });
  }

  for (const call of calls) {
    const key = `${call.actor}|${call.model}`;
    const buckets = dayOf(dayKey(call.createdAt)).agent_call;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.costUsd += call.costUsd;
      existing.durationMs += call.durationMs;
    } else {
      buckets.set(key, {
        bucket: key,
        actor: call.actor,
        model: call.model,
        count: 1,
        costUsd: call.costUsd,
        durationMs: call.durationMs,
      });
    }
  }

  let written = 0;
  for (const [day, kinds] of Array.from(byDay.entries())) {
    for (const kind of ["event", "agent_call"] as const) {
      for (const bucket of Array.from(kinds[kind].values())) {
        const data = {
          day,
          kind,
          bucket: bucket.bucket,
          eventType: bucket.eventType ?? null,
          actor: bucket.actor ?? null,
          model: bucket.model ?? null,
          count: bucket.count,
          costUsd: bucket.costUsd,
          durationMs: bucket.durationMs,
        };
        await prisma.auditRollup.upsert({
          where: { day_kind_bucket: { day, kind, bucket: bucket.bucket } },
          create: data,
          update: data,
        });
        written += 1;
      }
    }
  }

  return { days: byDay.size, buckets: written };
}

/**
 * Deletes audit rows older than the cutoff. One statement per table — the same
 * shape erasure for a single person takes (see deleteAuditDataForUser).
 */
export async function deleteOlderThan(cutoff: Date): Promise<{ events: number; calls: number }> {
  const events = await prisma.auditEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const calls = await prisma.agentCall.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { events: events.count, calls: calls.count };
}

/**
 * Erases one person's audit trail: one statement per table, no joins, no
 * cascade. ADR-0038 promises this is cheap, and this is the promise.
 *
 * Deliberately does NOT touch the rollups — they hold counts, never a userId,
 * so nothing about this person survives in them.
 */
export async function deleteAuditDataForUser(
  userId: string
): Promise<{ events: number; calls: number }> {
  const events = await prisma.auditEvent.deleteMany({ where: { userId } });
  const calls = await prisma.agentCall.deleteMany({ where: { userId } });
  return { events: events.count, calls: calls.count };
}

export interface RetentionTickResult {
  skipped?: "orchestration_running" | "already_running";
  rolledUpDays?: number;
  deletedEvents?: number;
  deletedCalls?: number;
}

let isRunning = false;

/**
 * One sweep: roll up, then delete.
 *
 * Skips entirely while a match cycle holds the orchestration lock. SQLite has a
 * single writer, and the matching sweep is the process doing the actual work —
 * a retention sweep is never worth making it wait. It runs daily, so skipping
 * a tick costs nothing.
 */
export async function runRetentionTick(now: Date = new Date()): Promise<RetentionTickResult> {
  if (isRunning) return { skipped: "already_running" };
  if (isOrchestrationRunning()) return { skipped: "orchestration_running" };

  isRunning = true;
  try {
    const cutoff = cutoffFor(now, retentionDays());
    // Rolled up through NOW, not through the cutoff: every day that will ever
    // be deleted is therefore already counted, with a wide margin. This
    // ordering is the whole reason no day can be lost.
    const { days } = await rollUpThrough(now);
    const deleted = await deleteOlderThan(cutoff);
    return {
      rolledUpDays: days,
      deletedEvents: deleted.events,
      deletedCalls: deleted.calls,
    };
  } catch (error) {
    // A failed sweep is not allowed to take the API process down with it: the
    // next tick tries again, and the only cost of a missed one is rows living
    // a day longer than they should.
    console.error("auditRetention: sweep failed:", error);
    return {};
  } finally {
    isRunning = false;
  }
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;

export function startAuditRetentionLoop(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runRetentionTick();
  }, sweepIntervalMs());
}

export function stopAuditRetentionLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
