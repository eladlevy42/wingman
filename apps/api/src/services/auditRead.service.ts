import { prisma } from "@wingman/database";
import {
  AuditEventTypeSchema,
  type AgentCallView,
  type AgentCostResponse,
  type AgentCostRow,
  type AuditTimelineEntry,
  type AuditTimelineResponse,
} from "@wingman/shared";
import { dayKey } from "./auditRetention.service";

// Read side of the audit trail, for /dev/audit (#555). Nothing here shows
// content, because neither table stores any (docs/adr/0038) — these functions
// shape ids, timings and enum members, and that is all there is to shape.

// Bounded so a dev page cannot pull an unbounded scan out of SQLite's single
// reader while a matching sweep is writing.
export const MAX_TIMELINE_EVENTS = 200;

function toCallView(call: {
  id: string;
  correlationId: string;
  actor: string;
  purpose: string;
  model: string;
  costUsd: number;
  durationMs: number;
  toolNames: string;
  retryCount: number;
  outcome: string;
  errorMessage: string | null;
  createdAt: Date;
}): AgentCallView {
  return {
    id: call.id,
    correlationId: call.correlationId,
    // The columns are plain strings in SQLite; the response schema is what
    // asserts they are still members of their enums on the way out.
    actor: call.actor as AgentCallView["actor"],
    purpose: call.purpose as AgentCallView["purpose"],
    model: call.model,
    costUsd: call.costUsd,
    durationMs: call.durationMs,
    toolNames: parseToolNames(call.toolNames),
    retryCount: call.retryCount,
    outcome: call.outcome as AgentCallView["outcome"],
    errorMessage: call.errorMessage,
    createdAt: call.createdAt.toISOString(),
  };
}

// Stored as a JSON string (SQLite has no array type). A corrupt value yields an
// empty list rather than failing the whole page — an audit reader that cannot
// open is worse than one missing a tool name.
function parseToolNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * One user's events, newest first, each carrying the agent calls that shared
 * its request. The join is `correlationId` and nothing else — no foreign key
 * exists between the tables, deliberately (docs/adr/0038).
 */
export async function getUserTimeline(userId: string): Promise<AuditTimelineResponse> {
  const events = await prisma.auditEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: MAX_TIMELINE_EVENTS,
  });

  const correlationIds = Array.from(new Set(events.map((event) => event.correlationId)));
  // The user's calls, plus any call sharing a correlationId with one of their
  // events — a sweep's negotiation calls carry the OTHER user's id on the half
  // of the deliberation that argues for them, and belong on both timelines.
  const calls = await prisma.agentCall.findMany({
    where: { OR: [{ userId }, { correlationId: { in: correlationIds } }] },
    orderBy: { createdAt: "asc" },
  });

  const callsByCorrelation = new Map<string, AgentCallView[]>();
  for (const call of calls) {
    const view = toCallView(call);
    const existing = callsByCorrelation.get(call.correlationId);
    if (existing) existing.push(view);
    else callsByCorrelation.set(call.correlationId, [view]);
  }

  const seenCorrelations = new Set<string>();
  const entries: AuditTimelineEntry[] = events.map((event) => {
    seenCorrelations.add(event.correlationId);
    return {
      id: event.id,
      type: AuditEventTypeSchema.parse(event.type),
      correlationId: event.correlationId,
      payload: parsePayload(event.payload),
      createdAt: event.createdAt.toISOString(),
      // Attached to the first (newest) event carrying this correlationId. Two
      // events in one request share the id, and duplicating the calls under
      // both would double the spend the page shows.
      agentCalls: callsByCorrelation.get(event.correlationId) ?? [],
    };
  });

  // Deduplicate: a correlationId appearing on two events must not attach its
  // calls twice.
  const attached = new Set<string>();
  for (const entry of entries) {
    if (attached.has(entry.correlationId)) entry.agentCalls = [];
    else attached.add(entry.correlationId);
  }

  const unattributedCalls = calls
    .filter((call) => !seenCorrelations.has(call.correlationId))
    .map(toCallView);

  return { userId, entries, unattributedCalls };
}

/**
 * Agent spend by day, actor and model.
 *
 * Reads raw rows for days still inside the retention window and the rollup for
 * days whose raw rows have been swept, so a range spanning the boundary still
 * adds up. `includesRolledUpDays` tells the page which it got — "no rows for
 * March" and "March was deleted" are different facts and must not look alike.
 */
export async function getAgentCosts(from: Date, to: Date): Promise<AgentCostResponse> {
  const calls = await prisma.agentCall.findMany({
    where: { createdAt: { gte: from, lte: to } },
    select: { actor: true, model: true, costUsd: true, durationMs: true, createdAt: true },
  });

  const rows = new Map<string, AgentCostRow>();
  const daysFromRaw = new Set<string>();
  for (const call of calls) {
    const day = dayKey(call.createdAt);
    daysFromRaw.add(day);
    const key = `${day}|${call.actor}|${call.model}`;
    const existing = rows.get(key);
    if (existing) {
      existing.calls += 1;
      existing.costUsd += call.costUsd;
      existing.durationMs += call.durationMs;
    } else {
      rows.set(key, {
        day,
        actor: call.actor,
        model: call.model,
        calls: 1,
        costUsd: call.costUsd,
        durationMs: call.durationMs,
      });
    }
  }

  const rollups = await prisma.auditRollup.findMany({
    where: { kind: "agent_call", day: { gte: dayKey(from), lte: dayKey(to) } },
  });

  let includesRolledUpDays = false;
  for (const rollup of rollups) {
    // A day with raw rows is answered from them: the rollup for a day still
    // inside the window can lag behind writes that landed after the last sweep.
    if (daysFromRaw.has(rollup.day)) continue;
    includesRolledUpDays = true;
    rows.set(`${rollup.day}|${rollup.actor}|${rollup.model}`, {
      day: rollup.day,
      actor: rollup.actor ?? "unknown",
      model: rollup.model ?? "unknown",
      calls: rollup.count,
      costUsd: rollup.costUsd,
      durationMs: rollup.durationMs,
    });
  }

  const ordered = Array.from(rows.values()).sort(
    (a, b) => b.day.localeCompare(a.day) || a.actor.localeCompare(b.actor)
  );

  return {
    rows: ordered,
    totalCostUsd: ordered.reduce((sum, row) => sum + row.costUsd, 0),
    totalCalls: ordered.reduce((sum, row) => sum + row.calls, 0),
    includesRolledUpDays,
  };
}
