import { z } from "zod";
import { NegotiationMessageSchema } from "./negotiation";

// Why a candidate did or didn't pass the deterministic filter's hard criteria
// (docs/adr/0006) — the first criterion that failed, checked in either
// direction (seeker->candidate or candidate->seeker must both pass).
// "incomplete_profile" covers a candidate row matching.service.ts's
// parseCandidate couldn't parse (missing/malformed structuredData) — it was
// never scored against any criterion.
// "recently_rejected" (#344) is a candidate this seeker's agent negotiation
// already turned down within the exclusion window — skipped this cycle to
// avoid paying for a re-negotiation that would almost certainly reject again,
// but time-boxed so an evolving profile/feedback can revive the pair later.
// "already_matched" (#375) is a candidate this seeker has ever completed a
// match with (been on a Blind Date with) — a permanent exclusion, independent
// of the recently_rejected window, since re-pairing a couple after a real
// date is not something to silently retry.
export const CandidateFailureReasonSchema = z.enum([
  "gender",
  "age",
  "distance",
  "incomplete_profile",
  "recently_rejected",
  "already_matched",
]);
export type CandidateFailureReason = z.infer<typeof CandidateFailureReasonSchema>;

// Per-signal contributions behind a candidate's weighted ranking score
// (Ranking Signals, docs/adr/0023, #300). Every field is the already-weighted
// contribution to the total, so the audit page can show the arithmetic;
// distanceKm is the tie-break input, not a score component.
// distanceUnknown flags a pair where at least one city couldn't be located
// (#331) — such pairs rank worst on the distance tie-break instead of reading
// as 0 km. Defaulted so MatchAttempt rows persisted before #331 still parse.
export const RankingSignalsSchema = z.object({
  hobbies: z.number().int().min(0),
  personality: z.number().int().min(0),
  socialEnergy: z.number().int().min(0),
  kids: z.number().int(),
  distanceKm: z.number().min(0),
  distanceUnknown: z.boolean().default(false),
});
export type RankingSignals = z.infer<typeof RankingSignalsSchema>;

// One candidate's full diagnostic score from a single deterministicFilter run
// — issue #253. `rank` is this candidate's 0-indexed position in the final
// top-5 shortlist that actually got negotiated; null means it passed hard
// criteria but didn't make the top 5 (or didn't pass at all).
// `overlapScore` holds the weighted Ranking Signals total since #300 (it can
// go negative on a kids clash); `signals` is its per-signal breakdown,
// optional so MatchAttempt rows persisted before #300 still parse.
export const CandidateScoreSchema = z.object({
  candidateId: z.string().uuid(),
  passedHardCriteria: z.boolean(),
  failureReason: CandidateFailureReasonSchema.nullable(),
  overlapScore: z.number().int().nullable(),
  rank: z.number().int().min(0).nullable(),
  signals: RankingSignalsSchema.nullable().optional(),
});
export type CandidateScore = z.infer<typeof CandidateScoreSchema>;

// "RUNNING" while matchOneUser is still walking the shortlist; "MATCHED" once
// a negotiation succeeds; "EXHAUSTED" if every shortlisted candidate was
// negotiated (or there were none) with no match and no best-available fallback
// was possible either; "FORCED" if the guaranteed-result fallback (#chat-flow
// #8) paired the user with the best-available candidate instead — distinct
// from "MATCHED" so the audit page can tell a negotiated match from a forced
// one (see #315); "FAILED" if either a negotiation turn threw mid-attempt
// (#339) or an unexpected error (DB failure, programmer bug) hit before any
// negotiation turn ran (#378) — see MatchAttemptFailureSchema's `reason` for
// telling the two apart. FAILED is distinct from EXHAUSTED: nothing was
// actually decided, a turn simply never completed.
export const MatchAttemptStatusSchema = z.enum([
  "RUNNING",
  "MATCHED",
  "EXHAUSTED",
  "FORCED",
  "FAILED",
]);
export type MatchAttemptStatus = z.infer<typeof MatchAttemptStatusSchema>;

// Which of the two FAILED sub-cases produced a MatchAttemptFailure (#378):
// "negotiation_turn" is a NegotiationTurnFailure thrown mid-loop (#339, after
// its own retries were already exhausted) — `log` is the partial transcript
// built before the throw (possibly empty, if the very first turn failed).
// "unexpected_error" is anything else (DB failure, programmer bug) caught
// before any negotiation turn ran — `log` is unconditionally empty since
// there was never a transcript to capture. Older FAILED rows persisted before
// #378 predate this field and default to "negotiation_turn", the only case
// that existed then.
export const MatchAttemptFailureReasonSchema = z.enum(["negotiation_turn", "unexpected_error"]);
export type MatchAttemptFailureReason = z.infer<typeof MatchAttemptFailureReasonSchema>;

// What was captured when an attempt was recorded FAILED (#339, #378): `log`
// and `error` per `reason` above. Present only on FAILED attempts.
export const MatchAttemptFailureSchema = z.object({
  log: z.array(NegotiationMessageSchema),
  error: z.string(),
  reason: MatchAttemptFailureReasonSchema.default("negotiation_turn"),
});
export type MatchAttemptFailure = z.infer<typeof MatchAttemptFailureSchema>;

// Why matchOneUser's shortlist walk stopped before exhausting every
// shortlisted candidate (#307). "sweep_budget" is the only case today: the
// SWEEP_BUDGET_USD guardrail tripped mid-walk. Distinct from
// MatchAttemptFailureReason — a stopped walk is not a failure, it's a
// deliberate early exit that still completes the attempt normally
// (EXHAUSTED/FORCED), just without trying every shortlisted candidate.
export const StoppedReasonSchema = z.enum(["sweep_budget"]);
export type StoppedReason = z.infer<typeof StoppedReasonSchema>;

// One negotiated candidate's outcome, joined from the Match row negotiating
// this candidate created — the second half of the pipeline (deterministic
// score -> negotiation transcript -> decision) issue #253 asks for.
export const NegotiationOutcomeSchema = z.object({
  matchId: z.string().uuid(),
  candidateId: z.string().uuid(),
  status: z.enum(["PENDING", "MATCHED", "REJECTED"]),
  scoreA: z.number().int(),
  scoreB: z.number().int(),
  deliberationLog: z.array(NegotiationMessageSchema),
  rationale: z.string().nullable(),
});
export type NegotiationOutcome = z.infer<typeof NegotiationOutcomeSchema>;

// History-list row — no candidateScores/negotiations payload, so browsing
// past attempts stays cheap. See MatchAttemptDetailSchema for the full view.
export const MatchAttemptSummarySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  status: MatchAttemptStatusSchema,
  candidateCount: z.number().int().min(0),
  negotiatedCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type MatchAttemptSummary = z.infer<typeof MatchAttemptSummarySchema>;

export const MatchAttemptDetailSchema = MatchAttemptSummarySchema.extend({
  candidateScores: z.array(CandidateScoreSchema),
  negotiations: z.array(NegotiationOutcomeSchema),
  failure: MatchAttemptFailureSchema.nullable(),
  stoppedReason: StoppedReasonSchema.nullable(),
});
export type MatchAttemptDetail = z.infer<typeof MatchAttemptDetailSchema>;
