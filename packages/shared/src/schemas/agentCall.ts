import { z } from "zod";

// The AgentCall vocabulary (docs/adr/0038, #553). One AgentCall row is written
// per agent call the app makes, and these schemas are what that write path
// parses against before touching the database — the same parse-then-write gate
// AuditEvent uses (schemas/audit.ts), for the same reason: "we promise not to
// log prompts" is unenforceable, a Zod parse at the write boundary is not.
//
// Metadata only, never content. The record schema below is .strict(), so a
// caller cannot smuggle a `prompt` or `response` field through by adding one —
// it fails the parse and the row is dropped. Agent content that IS kept has its
// own ADR and its own domain table (Match.deliberationLog, the interview
// transcript, MatchAttempt.failureLog).

// Which agent ran. A closed set rather than a free string so the table stays
// groupable ("what did negotiation cost last week?") and cannot drift into a
// log-label field — the human-readable label already lives in logLabel.
export const AgentActorSchema = z.enum([
  // The user-facing conversational agent, in any of its four modes.
  "barney",
  // The cheap per-turn helpers behind the structured interview (soft turn,
  // side question, addendum routing) — not Barney himself.
  "interview_helper",
  // One side of an agent-to-agent deliberation.
  "negotiation",
  // The three eval-only graders (docs/adr/0029, 0030, Track 2).
  "evalJudge",
  "consistencyJudge",
  "groundednessJudge",
]);

export type AgentActor = z.infer<typeof AgentActorSchema>;

// Why it ran. Deliberately coarser than the call site: it answers "what kind of
// work was this spend for", and the correlationId joins the row to the
// AuditEvent that says which user action caused it.
export const AgentPurposeSchema = z.enum([
  // Barney's conversational turns, by mode.
  "interview_turn",
  "pitch_turn",
  "debrief_turn",
  // The interview engine's per-turn helper calls.
  "interview_soft_turn",
  "interview_side_question",
  "interview_addendum",
  // The throwaway turn a warm interview session pays to spawn its subprocess
  // ahead of the first real soft turn (#249). Real spend, so it is recorded —
  // and separable from the turns that actually served the user.
  "session_prewarm",
  // Deliberation: the exchange itself, the independent score, and the
  // user-facing rationale each cost a separate call.
  "negotiation_turn",
  "negotiation_score",
  "negotiation_rationale",
  // The standalone rationale for a best-available fallback pairing.
  "fallback_rationale",
  // Eval graders.
  "eval_judgement",
  "dealbreaker_consistency",
  "groundedness_check",
]);

export type AgentPurpose = z.infer<typeof AgentPurposeSchema>;

// How the call ended. "failed" is a transient failure that exhausted its
// retries; the two named error outcomes are the non-retryable ones, kept
// distinct so an environment problem (no CLI, bad key) is never read as the
// API being flaky. See agentSdkClient's runAgentQuery.
export const AgentCallOutcomeSchema = z.enum(["ok", "failed", "auth_error", "sdk_unavailable"]);

export type AgentCallOutcome = z.infer<typeof AgentCallOutcomeSchema>;

// Every error this write path can see is built from a log label plus an SDK
// error code or subtype — none of them interpolate a prompt or a model reply.
// The cap is belt-and-braces against a future error that does, and keeps one
// pathological stack trace from bloating the table.
export const MAX_AGENT_ERROR_MESSAGE_LENGTH = 300;

// What every agent call must declare about itself. Required on the query
// params (not optional-with-a-default) so an agent added later cannot reach the
// API unattributed — the type stops it at compile time and the parse below
// stops anything that gets past the type.
//
// `correlationId` is optional here because the API boundary already mints one
// per request into AsyncLocalStorage (middleware/correlationId.ts); the writer
// reads it from there. A caller only passes it explicitly for work that runs
// outside any such scope and wants its own thread.
export const AgentAuditContextSchema = z
  .object({
    actor: AgentActorSchema,
    purpose: AgentPurposeSchema,
    // Null for calls with no user in scope — the eval graders, a fixture run.
    userId: z.string().min(1).nullish(),
    correlationId: z.string().min(1).optional(),
  })
  .strict();

export type AgentAuditContext = z.infer<typeof AgentAuditContextSchema>;

// One AgentCall row, as the writer assembles it. `.strict()` is the privacy
// gate: prompt/response/transcript fields are not declared here, so they cannot
// be written even by a caller that tries.
export const AgentCallRecordSchema = z
  .object({
    correlationId: z.string().min(1),
    userId: z.string().min(1).nullable(),
    actor: AgentActorSchema,
    purpose: AgentPurposeSchema,
    model: z.string().min(1),
    // Real Anthropic spend for the call. 0 when the SDK errored before it
    // reported one — undercounted rather than guessed (see AgentQueryResult).
    costUsd: z.number().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    // Tool NAMES only — never arguments, which carry user content.
    toolNames: z.array(z.string().min(1)),
    // Retries paid before this outcome: 0 on a first-attempt success.
    retryCount: z.number().int().nonnegative(),
    outcome: AgentCallOutcomeSchema,
    errorMessage: z.string().max(MAX_AGENT_ERROR_MESSAGE_LENGTH).nullable(),
  })
  .strict();

export type AgentCallRecord = z.infer<typeof AgentCallRecordSchema>;
