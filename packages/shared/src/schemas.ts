import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "./schemas/barney";
import { MatchingStateSchema } from "./schemas/user";

export const CreateUserSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/, "Only alphanumeric and underscores"),
});

export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  createdAt: z.string().datetime(),
});

export const ProfileStatusSchema = z.enum(["INCOMPLETE", "COMPLETED"]);

// A full interview transcript is many turns concatenated — much larger than
// a single message, but still bounded (#227) to keep an unbounded payload
// from reaching the DB or an LLM prompt.
const MAX_RAW_TRANSCRIPT_LENGTH = 50_000;

export const ProfileSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  rawTranscript: z.string().max(MAX_RAW_TRANSCRIPT_LENGTH),
  structuredData: z.string().nullable(),
  status: ProfileStatusSchema,
});

export const MatchStatusSchema = z.enum(["PENDING", "MATCHED", "REJECTED"]);

// How a Match came to be (#345). "NEGOTIATED" is a genuine agent-to-agent
// negotiation that cleared the mutual score threshold; "FORCED" is the
// best-available fallback pairing the closest fit without clearing the bar
// (forceMatchAndPersist, #chat-flow #8). A first-class field so forced matches
// are queryable instead of inferred from a fragile scoreA=scoreB=6 heuristic.
// Companion to MatchAttempt.status "FORCED" (#315), which labels the attempt.
export const MatchTypeSchema = z.enum(["NEGOTIATED", "FORCED"]);
export type MatchType = z.infer<typeof MatchTypeSchema>;

export const MatchSchema = z.object({
  id: z.string().uuid(),
  userAId: z.string().uuid(),
  userBId: z.string().uuid(),
  status: MatchStatusSchema,
  matchType: MatchTypeSchema,
  scoreA: z.number(),
  scoreB: z.number(),
  deliberationLog: z.string().nullable(),
  rationale: z.string().nullable(),
  // Blind Date fields (#57, docs/adr/0012) — both null until both users say yeah.
  venue: z.string().nullable(),
  dateTime: z.coerce.date().nullable(),
});

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(MAX_MESSAGE_LENGTH),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const SendMessageSchema = z.object({
  userId: z.string().uuid(),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
});

export const TriggerMatchSchema = z.object({
  userAId: z.string().uuid(),
  userBId: z.string().uuid(),
});

// Returned by POST /api/users/:id/trigger-match (#361): the cycle now runs in
// the background, so the response only says whether this press started one.
// started:false means a cycle was already in flight — the client treats both
// as "Barney is searching" and follows progress via /state + the
// orchestration-status endpoint.
export const TriggerMatchStartResponseSchema = z.object({
  started: z.boolean(),
});
export type TriggerMatchStartResponse = z.infer<typeof TriggerMatchStartResponseSchema>;

// Returned by GET /api/match/orchestration-status (#361).
export const OrchestrationStatusResponseSchema = z.object({
  running: z.boolean(),
});
export type OrchestrationStatusResponse = z.infer<typeof OrchestrationStatusResponseSchema>;

export const DecisionSchema = z.enum(["yeah", "nah"]);

export const DecideMatchSchema = z.object({
  matchId: z.string().uuid(),
  userId: z.string().uuid(),
  decision: DecisionSchema,
});

// Returned by POST /api/match/decide. waiting is true until both users have
// decided — see docs/adr/0011 for the resolver that consumes this.
export const DecideMatchResponseSchema = z.object({
  waiting: z.boolean(),
});
export type DecideMatchResponse = z.infer<typeof DecideMatchResponseSchema>;

// Choose-your-times step (#248). The user submits 1-3 of the shared candidate
// slots offered while the match is in CHOOSING_TIMES; each slot is an ISO
// datetime string that must be one of the match's candidateSlots (validated
// server-side against the stored set).
export const SubmitAvailabilitySchema = z.object({
  matchId: z.string().uuid(),
  userId: z.string().uuid(),
  slots: z.array(z.string().datetime()).min(1).max(3),
});

// Returned by POST /api/match/availability. waiting is true until both users
// have submitted; matchingState reflects the resulting state (CHOOSING_TIMES
// while still waiting, DATE_ASSIGNED once both have picked and a slot was set).
export const SubmitAvailabilityResponseSchema = z.object({
  waiting: z.boolean(),
  matchingState: MatchingStateSchema,
});
export type SubmitAvailabilityResponse = z.infer<typeof SubmitAvailabilityResponseSchema>;
