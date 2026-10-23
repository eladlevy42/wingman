import { z } from "zod";

// One entry in a Match's deliberationLog — the agent-to-agent negotiation
// transcript. `speaker` is the human-readable agent label (e.g. "Alex's agent"),
// derived from the represented human's User.name. Array order is turn order;
// there is deliberately no turn index. #42 serializes NegotiationMessage[] into
// Match.deliberationLog (a JSON string). See docs/adr/0007.
export const NegotiationMessageSchema = z.object({
  speaker: z.string(),
  content: z.string(),
  // Per-turn agent reasoning (adaptive extended thinking) — present only on
  // eval runs that opt into capture (issue #420). Absent on production matches.
  thinking: z.string().optional(),
});

export type NegotiationMessage = z.infer<typeof NegotiationMessageSchema>;

// The outcome of a full negotiation: the transcript plus each agent's
// independent 1-10 compatibility score and the derived match decision. #41
// produces this from runNegotiation; #42 consumes scoreA/scoreB to build the
// Match record. `matched` is true only when BOTH agents score at or above the
// match threshold. See docs/adr/0007.
// `rationale` is a matchmaker-tone compatibility summary generated only when
// matched (null when not); both agents write their own 2-3 sentence half,
// joined by a blank line, so it's grounded fairly on both humans rather than
// solely agent A's advocacy framing. See docs/adr/0010.
export const NegotiationResultSchema = z.object({
  deliberationLog: z.array(NegotiationMessageSchema),
  scoreA: z.number().int().min(1).max(10),
  scoreB: z.number().int().min(1).max(10),
  matched: z.boolean(),
  rationale: z.string().min(1).nullable(),
  // Each agent's own saveScore rationale (issue #420) — previously produced by
  // the tool then discarded. Surfaced for the eval JSON log. Null only if a
  // reask path yielded no rationale. Production's createMatch ignores these.
  rationaleA: z.string().min(1).nullable().default(null),
  rationaleB: z.string().min(1).nullable().default(null),
  // Real Anthropic API cost/time for the whole negotiation (both agents,
  // every turn + scoring + rationale). Production's createMatch ignores
  // these; only the eval dashboard's Track 2 reads them. See issue #250.
  costUsd: z.number().min(0).default(0),
  durationMs: z.number().min(0).default(0),
  // Every protocol-guard re-ask that fired during the negotiation (issue
  // #422): which agent's turn tripped detectTurnViolations and the violation
  // kinds detected, previously visible only as console.warn scrollback.
  // Empty on a clean run; defaulted so pre-#422 rows parse. Production's
  // createMatch ignores this — only the eval JSON log surfaces it.
  guardRetries: z.array(z.object({ speaker: z.string(), kinds: z.array(z.string()) })).default([]),
});

export type NegotiationResult = z.infer<typeof NegotiationResultSchema>;

// Structured capture for the saveScore tool (docs/adr/0007 §3: "structured
// capture — a tool, for consistency with saveProfile/saveWantedProfile").
// `rationale` is required so the model reasons through the dealbreaker gate
// before committing to a number, even though nothing downstream persists it.
export const NegotiationScoreInputSchema = z.object({
  score: z.number().int().min(1).max(10),
  rationale: z.string(),
});

export type NegotiationScoreInput = z.infer<typeof NegotiationScoreInputSchema>;
