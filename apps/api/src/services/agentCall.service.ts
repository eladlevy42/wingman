import { randomUUID } from "node:crypto";
import { prisma } from "@wingman/database";
import {
  AgentCallRecordSchema,
  AgentAuditContextSchema,
  type AgentActor,
  type AgentAuditContext,
  type AgentCallRecord,
  type AgentPurpose,
} from "@wingman/shared";
import { currentCorrelationId } from "../middleware/correlationId";

/**
 * Records one agent call (docs/adr/0038, #553). The single writer for the
 * AgentCall table — every agent call in the app goes through the one chokepoint
 * that calls this (agents/agentSdkClient.ts), so the table is the complete
 * record of agent activity and spend.
 *
 * Mirrors recordEvent's two guarantees (services/audit.service.ts):
 *
 * 1. **The row is validated before it is written.** AgentCallRecordSchema is
 *    `.strict()`, so a field that is not part of the declared metadata shape —
 *    a prompt, a reply, a transcript — fails the parse and the row is dropped
 *    rather than written raw.
 *
 * 2. **This function never throws.** An AgentCall write is subordinate to the
 *    agent call it describes: a failure here is logged and swallowed so it can
 *    never turn a completed (paid for) agent call into a failed request.
 */
export async function recordAgentCall(record: AgentCallRecord): Promise<void> {
  try {
    const parsed = AgentCallRecordSchema.safeParse(record);
    if (!parsed.success) {
      console.error(
        `agentCall: dropped ${record.actor}/${record.purpose} row — failed its schema:`,
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      );
      return;
    }

    const row = parsed.data;
    await prisma.agentCall.create({
      data: {
        correlationId: row.correlationId,
        userId: row.userId,
        actor: row.actor,
        purpose: row.purpose,
        model: row.model,
        costUsd: row.costUsd,
        durationMs: row.durationMs,
        // Names only — the array is JSON-encoded to match the schema's String
        // column (SQLite has no array type).
        toolNames: JSON.stringify(row.toolNames),
        retryCount: row.retryCount,
        outcome: row.outcome,
        errorMessage: row.errorMessage,
      },
    });
  } catch (error) {
    console.error(`agentCall: failed to record ${record.actor}/${record.purpose} row:`, error);
  }
}

// Thrown when an agent call carries no usable audit context. Deliberately
// thrown BEFORE the API call rather than recorded as an unattributed row: the
// point of the required context is that no agent can run unrecorded, and
// silently writing a row with no actor would defeat it (docs/adr/0038).
export class AgentAuditContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAuditContextError";
  }
}

/**
 * Validates an agent call's audit context and resolves the correlationId it
 * will be recorded under. The TypeScript signature on AgentQueryParams keeps
 * honest callers honest at compile time; this stops everything else.
 */
export function resolveAuditContext(
  logLabel: string,
  audit: AgentAuditContext | undefined
): {
  correlationId: string;
  userId: string | null;
  actor: AgentActor;
  purpose: AgentPurpose;
} {
  const parsed = AgentAuditContextSchema.safeParse(audit);
  if (!parsed.success) {
    throw new AgentAuditContextError(
      `${logLabel}: agent call is missing valid audit context — ` +
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    );
  }
  return {
    // Inside a request this is the middleware's per-request id, so the row
    // shares it with the AuditEvent for the same user action. Outside one, an
    // explicit id or a fresh one — still non-null, just correlating nothing.
    correlationId: parsed.data.correlationId ?? currentCorrelationId() ?? randomUUID(),
    userId: parsed.data.userId ?? null,
    actor: parsed.data.actor,
    purpose: parsed.data.purpose,
  };
}
