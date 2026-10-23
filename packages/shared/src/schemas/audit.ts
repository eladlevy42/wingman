import { z } from "zod";
import { MatchingStateSchema } from "./user";
import { BarneyModeSchema } from "./barney";
import { InterviewLanguageSchema } from "../i18n";
import { TelemetryActionSchema, TelemetryClientSchema, TelemetryScreenSchema } from "./telemetry";

// The audit-event vocabulary (docs/adr/0038, #552). This closed union IS the
// privacy gate: the write path (audit.service.ts) parses every payload against
// its type's schema below and drops what does not match, so a field that is not
// declared here cannot reach the AuditEvent table. Every schema is .strict()
// for exactly that reason — an unknown key is a parse failure, not a passenger.
//
// Metadata only, never content: no payload may carry email, phone, name,
// studentId, photoUrl or free-form message text (audit.test.ts pins this
// structurally). The text stays in the domain tables that have ADRs justifying
// it — the interview transcript, deliberationLog, FeedbackRound.
export const AuditEventTypeSchema = z.enum([
  "USER_REGISTERED",
  "USER_AUTHENTICATED",
  // Account erasure (#561, docs/adr/0040). Recorded before the erasure runs and
  // removed by it — deleteAuditDataForUser() takes this row too, so a completed
  // deletion leaves nothing keyed by the departed userId.
  "USER_DELETED",
  "MATCHING_STATE_CHANGED",
  "INTERVIEW_TURN",
  "INTERVIEW_COMPLETED",
  // The mid-interview language toggle (ADR-0037). Written by the server when it
  // switches the engine, not posted by the client.
  "INTERVIEW_LANGUAGE_CHANGED",
  "PHOTO_UPLOADED",
  "PITCH_DECIDED",
  "TIMES_PROPOSED",
  "TIMES_CHOSEN",
  "DEBRIEF_COMPLETED",
  // Client-emitted (#554). Everything above is written by the server from work
  // it did; these two are the only members a client may POST — see
  // CLIENT_AUDIT_EVENT_TYPES below.
  "SCREEN_VIEWED",
  "CTA_TAPPED",
]);

export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

// What moved a user's matchingState. A closed set rather than a free string so
// the payload stays queryable ("how many WAITING re-entries were rejections?")
// and cannot become a log-message field by accretion.
export const MatchingStateTriggerSchema = z.enum([
  // Phase 2 completed — persistWantedProfile flips IDLE -> WAITING.
  "phase2_completed",
  // A negotiation cleared the threshold — orchestration flips WAITING -> MATCHED.
  "negotiation_matched",
  // A Nah or an expired decision window — decision.service sends both users
  // back to WAITING.
  "match_rejected",
  // Both said Yeah — scheduling offers slots and flips MATCHED -> CHOOSING_TIMES.
  "times_started",
  // A slot was locked in — scheduling flips CHOOSING_TIMES -> DATE_ASSIGNED.
  "date_assigned",
  // The debrief persisted feedback — followup returns the user to WAITING.
  "debrief_completed",
]);

// The two onboarding interviews. Pitch and debrief are Barney modes too, but
// neither is an interview whose completion is an event — pitch ends in a
// PITCH_DECIDED, debrief in a DEBRIEF_COMPLETED.
const InterviewModeSchema = z.enum(["interview_self", "interview_wants"]);

// One payload schema per vocabulary member. Match ids appear as z.string().uuid()
// — an opaque row key, constrained so the field cannot carry text.
export const AuditEventPayloadSchemas = {
  USER_REGISTERED: z.object({}).strict(),
  USER_DELETED: z.object({}).strict(),
  USER_AUTHENTICATED: z
    .object({
      // "password" is the account login; "university" is the community-gate
      // verification step (#275).
      method: z.enum(["password", "university"]),
    })
    .strict(),
  MATCHING_STATE_CHANGED: z
    .object({
      from: MatchingStateSchema,
      to: MatchingStateSchema,
      trigger: MatchingStateTriggerSchema,
      // Present when a specific Match drove the transition; absent for
      // phase2_completed, which happens before any match exists.
      matchId: z.string().uuid().optional(),
    })
    .strict(),
  INTERVIEW_TURN: z
    .object({
      mode: BarneyModeSchema,
      // Metadata about the turn, never its text (docs/adr/0038).
      latencyMs: z.number().int().nonnegative().optional(),
      answerLength: z.number().int().nonnegative().optional(),
    })
    .strict(),
  INTERVIEW_COMPLETED: z.object({ mode: InterviewModeSchema }).strict(),
  INTERVIEW_LANGUAGE_CHANGED: z
    .object({ mode: InterviewModeSchema, language: InterviewLanguageSchema })
    .strict(),
  PHOTO_UPLOADED: z.object({}).strict(),
  PITCH_DECIDED: z
    .object({
      matchId: z.string().uuid(),
      decision: z.enum(["yeah", "nah"]),
    })
    .strict(),
  TIMES_PROPOSED: z
    .object({
      matchId: z.string().uuid(),
      // The proposer forwards 1..MAX_PROPOSED_SLOTS (3) of the offered slots.
      slotCount: z.number().int().min(1).max(3),
    })
    .strict(),
  TIMES_CHOSEN: z.object({ matchId: z.string().uuid() }).strict(),
  DEBRIEF_COMPLETED: z.object({ matchId: z.string().uuid() }).strict(),
  SCREEN_VIEWED: z
    .object({ screen: TelemetryScreenSchema, client: TelemetryClientSchema })
    .strict(),
  CTA_TAPPED: z
    .object({
      screen: TelemetryScreenSchema,
      action: TelemetryActionSchema,
      client: TelemetryClientSchema,
    })
    .strict(),
} as const satisfies Record<AuditEventType, z.ZodTypeAny>;

// The subset a client is allowed to POST to /api/telemetry (#554). The endpoint
// takes untrusted input: without this gate a client could forge a
// USER_REGISTERED or a MATCHING_STATE_CHANGED and the audit trail would record
// a state transition that never happened. Everything outside this list is
// written only by the server, from work the server itself did.
export const CLIENT_AUDIT_EVENT_TYPES = ["SCREEN_VIEWED", "CTA_TAPPED"] as const;

export type ClientAuditEventType = (typeof CLIENT_AUDIT_EVENT_TYPES)[number];

export function isClientAuditEventType(type: string): type is ClientAuditEventType {
  return (CLIENT_AUDIT_EVENT_TYPES as readonly string[]).includes(type);
}

export type AuditEventPayload<T extends AuditEventType> = z.infer<
  (typeof AuditEventPayloadSchemas)[T]
>;

// The discriminated-union parse: given a type, validate a payload against that
// type's schema. The one function the write path calls before touching the
// database — see recordEvent (apps/api/src/services/audit.service.ts).
export function parseAuditPayload(
  type: AuditEventType,
  payload: unknown
): z.SafeParseReturnType<unknown, unknown> {
  return AuditEventPayloadSchemas[type].safeParse(payload);
}
