import { z } from "zod";
import { GoldenPairCategorySchema } from "./goldenPair";

// Route param validation for eval endpoints — issue #87.
export const EvalTrackParamSchema = z.coerce.number().int().min(1).max(3);

export type EvalTrack = z.infer<typeof EvalTrackParamSchema>;

// Model tier a track run can use for its LLM-backed steps (Track 2 negotiation,
// Track 3 extraction, and Track 2's judge pass). See issue #250.
export const EVAL_MODELS = ["haiku", "sonnet", "opus"] as const;
export const EvalModelSchema = z.enum(EVAL_MODELS);
export type EvalModel = z.infer<typeof EvalModelSchema>;

// "running" | "completed" | "failed" | "stopped" (stopped = user-cancelled mid-run)
export const EvalRunStatusSchema = z.enum(["running", "completed", "failed", "stopped"]);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

// Configures a single eval run — issue #250's "actions" panel. `count` caps
// how many cases (users / golden pairs / seed transcripts) the run covers;
// omitted means "all". `seed` makes a capped subset reproducible.
export const EvalRunConfigSchema = z.object({
  count: z.number().int().min(1).max(500).optional(),
  // Turns alternate strictly A/B (see runNegotiation) — must stay even, or
  // one agent gets an extra turn and Track 2's per-pair comparison skews.
  turns: z
    .number()
    .int()
    .min(2)
    .max(8)
    .refine((n) => n % 2 === 0, "turns must be even")
    .optional(),
  seed: z.number().int().optional(),
  barneyModel: EvalModelSchema.default("sonnet"),
  judgeModel: EvalModelSchema.default("sonnet"),
  budgetCapUsd: z.number().positive().optional(),
  // Eval-only (#420): capture each negotiation turn's extended-thinking
  // reasoning into the run's deliberation log / JSON evidence. Off by
  // default so production and most eval runs stay unaffected.
  captureThinking: z.boolean().optional(),
});
export type EvalRunConfig = z.infer<typeof EvalRunConfigSchema>;

export const EvalStartRunRequestSchema = z.object({
  track: EvalTrackParamSchema,
  config: EvalRunConfigSchema.partial().optional(),
});
export type EvalStartRunRequest = z.infer<typeof EvalStartRunRequestSchema>;

// Response schema for Track 1 — see docs/adr/0008.
export const PerUserResultSchema = z.object({
  userId: z.string().uuid(),
  actual: z.array(z.string().uuid()),
  expected: z.array(z.string().uuid()),
  precision: z.number().min(0).max(1),
  costUsd: z.number().min(0).default(0),
  durationMs: z.number().min(0).default(0),
});

export type PerUserResult = z.infer<typeof PerUserResultSchema>;

export const Track1ResultSchema = z.object({
  meanPrecision: z.number().min(0).max(1),
  perUser: z.array(PerUserResultSchema),
});

export type Track1Result = z.infer<typeof Track1ResultSchema>;

// Independent auditor verdict for a negotiation transcript: whether each side's
// self-score is consistent with what that side said. `explanation` is the
// judge's short note. The scoring rubric itself is omitted in this showcase.
export const ConsistencyVerdictSchema = z.object({
  aDealbreakerViolated: z.boolean(),
  aConsistent: z.boolean(),
  bDealbreakerViolated: z.boolean(),
  bConsistent: z.boolean(),
  explanation: z.string(),
});

export type ConsistencyVerdict = z.infer<typeof ConsistencyVerdictSchema>;

// One factual claim an agent made about its own human that the groundedness
// judge could not support from that human's profile (issue #336). `claim` is
// the flagged assertion; `reason` is the judge's one-line justification.
export const GroundednessFlagSchema = z.object({
  claim: z.string(),
  reason: z.string(),
  // "self" = claim about the speaker's own human, checked vs own profile.
  // "about-other" = claim the speaker made about the OTHER human, checked
  // vs the other human's profile (issue #420). Defaulted so pre-existing
  // rows and the saveGroundedness tool (which doesn't set it) still parse.
  kind: z.enum(["self", "about-other"]).default("self"),
});
export type GroundednessFlag = z.infer<typeof GroundednessFlagSchema>;

// Structured payload the groundedness judge reports via its saveGroundedness
// tool (issue #336), for one speaker: how many factual claims it counted and
// which of those it judged unsupported by the speaker's own profile.
export const GroundednessJudgeInputSchema = z.object({
  totalClaims: z.number().int().min(0),
  ungroundedClaims: z.array(GroundednessFlagSchema),
});
export type GroundednessJudgeInput = z.infer<typeof GroundednessJudgeInputSchema>;

// Per-pair groundedness summary (issue #336) — both speakers' claims graded
// against their own human's profile, combined. `ungroundedRate` = ungrounded /
// total (0 when no claims were made). `flags` attributes each unsupported claim
// to the speaker who made it. Nullable/defaulted so pre-#336 rows and the
// best-available fallback path (which runs no real negotiation) still parse.
export const Track2GroundednessSchema = z.object({
  totalClaims: z.number().int().min(0),
  ungroundedCount: z.number().int().min(0),
  ungroundedRate: z.number().min(0).max(1),
  flags: z.array(GroundednessFlagSchema.extend({ speaker: z.string() })),
});
export type Track2Groundedness = z.infer<typeof Track2GroundednessSchema>;

// Response schema for Track 2 — one row (one "case") per GoldenPair.
// `judgeScore`/`judgeRationale` come from an independent judge-model pass over
// the transcript (issue #250) — distinct from scoreA/scoreB, which are each
// negotiating agent's own self-report. `transcript` surfaces the deliberation
// log the dashboard renders per case (closes the gap noted in docs/adr/0007:
// "no end user reads the transcript — only developers, via the eval dashboard").
// `dealbreakerConsistency` is a second, independent judge pass (issue #337)
// checking scoreA/scoreB against the Dealbreaker Gate given the same transcript.
// `groundedness` grades whether each agent's factual claims about its own human
// are supported by that human's profile (issue #336).
export const Track2PairResultSchema = z.object({
  pairId: z.string().uuid(),
  goldenScore: z.number().int().min(1).max(10),
  // The golden category and whether the engine's outcome landed in its band —
  // Track 2's headline accuracy signal (issue #398), robust to the within-band
  // label noise and A/B asymmetry that the per-side deltas below conflate.
  // Optional so runs recorded before #398 (which lack them) still parse.
  category: GoldenPairCategorySchema.optional(),
  bandAgreement: z.boolean().optional(),
  // Per-side band verdicts (issue #422): bandAgreement buckets the rounded
  // MEAN, so a borderline couple's clean 6/7 rounds up into the compatible
  // band on one point of noise — at the band edge the per-side bits are the
  // finer signal (docs/adr/0030). Optional so pre-#422 runs parse.
  bandAgreementA: z.boolean().optional(),
  bandAgreementB: z.boolean().optional(),
  scoreA: z.number().int().min(1).max(10),
  scoreB: z.number().int().min(1).max(10),
  // Signed per-side distance to goldenScore. Kept as a secondary diagnostic
  // (now against a deterministic score, #392), not the headline metric.
  deltaA: z.number().int(),
  deltaB: z.number().int(),
  matched: z.boolean(),
  judgeScore: z.number().int().min(1).max(10).nullable().default(null),
  judgeRationale: z.string().nullable().default(null),
  dealbreakerConsistency: ConsistencyVerdictSchema.nullable().default(null),
  groundedness: Track2GroundednessSchema.nullable().default(null),
  transcript: z.string().default(""),
  costUsd: z.number().min(0).default(0),
  durationMs: z.number().min(0).default(0),
});

export type Track2PairResult = z.infer<typeof Track2PairResultSchema>;

export const Track2ResultSchema = z.array(Track2PairResultSchema);

export type Track2Result = z.infer<typeof Track2ResultSchema>;

// One UserProfile field comparison, nested inside a Track3TranscriptResult.
export const Track3FieldResultSchema = z.object({
  field: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
  match: z.boolean(),
});

export type Track3FieldResult = z.infer<typeof Track3FieldResultSchema>;

// Response schema for Track 3 — one row (one "case") per SeedTranscript, with
// its field-level comparisons nested underneath. Grouped by transcript (rather
// than the old flat one-row-per-field shape) so the dashboard can render one
// accordion card per case, per issue #250.
export const Track3TranscriptResultSchema = z.object({
  userId: z.string().uuid(),
  transcriptId: z.string().uuid(),
  fields: z.array(Track3FieldResultSchema),
  matchCount: z.number().int().min(0),
  fieldCount: z.number().int().min(0),
  costUsd: z.number().min(0).default(0),
  durationMs: z.number().min(0).default(0),
});

export type Track3TranscriptResult = z.infer<typeof Track3TranscriptResultSchema>;

export const Track3ResultSchema = z.array(Track3TranscriptResultSchema);

export type Track3Result = z.infer<typeof Track3ResultSchema>;

export const EvalResultSchema = z.union([
  Track1ResultSchema,
  Track2ResultSchema,
  Track3ResultSchema,
]);
export type EvalResult = z.infer<typeof EvalResultSchema>;

// A run row as listed in the dashboard's history sidebar — no `result` payload
// (that's fetched separately per run via EvalRunDetailSchema, to keep the list
// call cheap).
export const EvalRunSummarySchema = z.object({
  id: z.string().uuid(),
  track: EvalTrackParamSchema,
  status: EvalRunStatusSchema,
  config: EvalRunConfigSchema,
  costUsd: z.number().min(0),
  durationMs: z.number().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EvalRunSummary = z.infer<typeof EvalRunSummarySchema>;

export const EvalRunDetailSchema = EvalRunSummarySchema.extend({
  result: EvalResultSchema.nullable(),
  error: z.string().nullable(),
});
export type EvalRunDetail = z.infer<typeof EvalRunDetailSchema>;

// Progress events streamed over SSE from GET /api/eval/runs/:id/stream while
// a run is in flight (issue #250 "live results"). One "case" event per
// completed case; a final "done"/"stopped"/"error" event closes the stream.
export const EvalProgressEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("case"),
    index: z.number().int().min(0),
    total: z.number().int().min(0),
    caseCostUsd: z.number().min(0),
    caseDurationMs: z.number().min(0),
    totalCostUsd: z.number().min(0),
    elapsedMs: z.number().min(0),
    // Normalized 0-1 so the dashboard can color-code live rows the same way
    // across all three tracks, ahead of the full per-case result being
    // available. `summary` is a short human-readable line for the live row.
    score: z.number().min(0).max(1),
    summary: z.string(),
  }),
  z.object({ type: z.literal("done"), run: EvalRunDetailSchema }),
  z.object({ type: z.literal("stopped"), run: EvalRunDetailSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type EvalProgressEvent = z.infer<typeof EvalProgressEventSchema>;
