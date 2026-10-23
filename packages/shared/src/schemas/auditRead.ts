import { z } from "zod";
import { AuditEventTypeSchema } from "./audit";
import { AgentActorSchema, AgentCallOutcomeSchema, AgentPurposeSchema } from "./agentCall";

// What the /dev/audit page reads (#555). Metadata only, because metadata is all
// that is stored — there is no message or answer text in either table to show
// (docs/adr/0038), and these response shapes are where that stays true at the
// API boundary rather than only at the write path.

// One agent call, as the timeline and the cost view show it.
export const AgentCallViewSchema = z
  .object({
    id: z.string(),
    correlationId: z.string(),
    actor: AgentActorSchema,
    purpose: AgentPurposeSchema,
    model: z.string(),
    costUsd: z.number(),
    durationMs: z.number().int(),
    toolNames: z.array(z.string()),
    retryCount: z.number().int(),
    outcome: AgentCallOutcomeSchema,
    errorMessage: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export type AgentCallView = z.infer<typeof AgentCallViewSchema>;

// One user action, with the agent calls the same request caused hanging off it.
// The join is `correlationId` — the whole reason it exists (docs/adr/0038).
export const AuditTimelineEntrySchema = z
  .object({
    id: z.string(),
    type: AuditEventTypeSchema,
    correlationId: z.string(),
    // Parsed back from the stored JSON string. Every value in it is a number,
    // a boolean, or a member of a closed enum — never free text.
    payload: z.record(z.unknown()),
    createdAt: z.string(),
    agentCalls: z.array(AgentCallViewSchema),
  })
  .strict();

export type AuditTimelineEntry = z.infer<typeof AuditTimelineEntrySchema>;

export const AuditTimelineResponseSchema = z
  .object({
    userId: z.string(),
    entries: z.array(AuditTimelineEntrySchema),
    // Agent calls in the range that no event shares a correlationId with — a
    // sweep's negotiation calls, which are caused by the clock rather than by
    // anything the user did. Shown separately rather than dropped, so the
    // page's spend total reconciles with the table.
    unattributedCalls: z.array(AgentCallViewSchema),
  })
  .strict();

export type AuditTimelineResponse = z.infer<typeof AuditTimelineResponseSchema>;

// One row of the agent-cost summary: a day, a model and an actor.
export const AgentCostRowSchema = z
  .object({
    day: z.string(),
    actor: z.string(),
    model: z.string(),
    calls: z.number().int(),
    costUsd: z.number(),
    durationMs: z.number().int(),
  })
  .strict();

export type AgentCostRow = z.infer<typeof AgentCostRowSchema>;

export const AgentCostResponseSchema = z
  .object({
    rows: z.array(AgentCostRowSchema),
    totalCostUsd: z.number(),
    totalCalls: z.number().int(),
    // True when any day in the range was answered from the rollup rather than
    // from raw rows — i.e. its raw rows have been swept. The page says so,
    // because "no rows for March" and "March was deleted" are different facts.
    includesRolledUpDays: z.boolean(),
  })
  .strict();

export type AgentCostResponse = z.infer<typeof AgentCostResponseSchema>;
