import { randomUUID } from "node:crypto";
import { prisma } from "@wingman/database";
import { parseAuditPayload } from "@wingman/shared";
import type { AuditEventPayload, AuditEventType } from "@wingman/shared";
import { currentCorrelationId } from "../middleware/correlationId";

// Who an event is about: a known user, or — for pre-auth client events — an
// anonymous per-launch session id. Exactly one of the two, never both: the
// never-linked guarantee (docs/adr/0038) is enforced here at the write path,
// not just promised.
export type AuditSubject =
  | { userId: string; anonSessionId?: undefined }
  | { anonSessionId: string; userId?: undefined };

/**
 * Records one audit event (docs/adr/0038, #552). The single writer for the
 * AuditEvent table — every event in the app goes through this parse-then-write.
 *
 * Two properties every caller can rely on:
 *
 * 1. **The payload is validated before it is written.** The type's Zod schema
 *    (packages/shared/src/schemas/audit.ts) is the privacy gate: a payload
 *    that does not parse — unknown field, wrong type, missing required field —
 *    is dropped and logged, never written raw. The TypeScript signature keeps
 *    honest callers honest at compile time; the runtime parse stops the rest.
 *
 * 2. **This function never throws.** An audit write is subordinate to the
 *    request that produced it (CLAUDE.md §9 rules out a queue, so these are
 *    direct SQLite writes) — a failure here is logged and swallowed so it can
 *    never break the user-facing action being recorded.
 */
export async function recordEvent<T extends AuditEventType>(
  type: T,
  payload: AuditEventPayload<T>,
  subject: AuditSubject
): Promise<void> {
  try {
    // Runtime XOR guard even though the type forbids both/neither: subjects are
    // built from request data several layers up, and a linkage bug here would
    // quietly build the retroactive-identification capability ADR-0038 rejects.
    const hasUser = subject.userId != null;
    const hasAnon = subject.anonSessionId != null;
    if (hasUser === hasAnon) {
      console.error(
        `audit: dropped ${type} event — expected exactly one of userId/anonSessionId, got ` +
          (hasUser ? "both" : "neither")
      );
      return;
    }

    const parsed = parseAuditPayload(type, payload);
    if (!parsed.success) {
      console.error(
        `audit: dropped ${type} event — payload failed its schema:`,
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      );
      return;
    }

    await prisma.auditEvent.create({
      data: {
        type,
        userId: subject.userId ?? null,
        anonSessionId: subject.anonSessionId ?? null,
        // Inside a request this is the middleware's per-request id; outside one
        // (a sweep that didn't opt into runWithCorrelationId) each event gets a
        // fresh id — still non-null, just correlating nothing.
        correlationId: currentCorrelationId() ?? randomUUID(),
        payload: JSON.stringify(parsed.data),
      },
    });
  } catch (error) {
    console.error(`audit: failed to record ${type} event:`, error);
  }
}
