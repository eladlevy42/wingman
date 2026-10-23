import { z } from "zod";
import { NegotiationMessageSchema } from "./negotiation";
import { GroundednessFlagSchema, ConsistencyVerdictSchema } from "./eval";

// One couple's full audit trail for a single eval run (issue #420): everything
// needed to analyze the negotiation after the fact — conversation, per-turn
// agent reasoning, why each agent scored as it did, whether either agent made
// ungrounded claims, and the outcome vs. the couple's golden score.
export const Track2LogRecordSchema = z.object({
  couple: z.object({
    pairId: z.string(),
    userAId: z.string(),
    userBId: z.string(),
    nameA: z.string(),
    nameB: z.string(),
    intendedGoldenScore: z.number().int().min(1).max(10),
    category: z.string(),
  }),
  conversation: z.array(NegotiationMessageSchema), // content + optional thinking
  scoreRationales: z.object({
    a: z.string().nullable(),
    b: z.string().nullable(),
  }),
  lieFlags: z.object({
    a: z.array(GroundednessFlagSchema),
    b: z.array(GroundednessFlagSchema),
    totalClaims: z.number().int().min(0),
  }),
  consistency: ConsistencyVerdictSchema.nullable(),
  // Protocol violations that survived the turn-level retry guard (#420): a
  // leaked numeric score or a staged/fabricated other-side turn still present
  // in the final transcript. A non-empty list means this case's transcript is
  // contaminated (a judge may have scored on invented evidence) and it should
  // be discarded from calibration, not trusted. Defaulted so pre-existing rows
  // parse. See detectTurnViolations in negotiation.agent.ts.
  protocolViolations: z
    .array(z.object({ speaker: z.string(), kinds: z.array(z.string()), snippet: z.string() }))
    .default([]),
  // Quiet ventriloquism that SURVIVED the turn-level retry (issue #422): a turn
  // still staging a whole Q&A exchange (asks, invents the answer, asks again).
  // Deliberately separate from protocolViolations above: this detector is a
  // structural heuristic sized for a cheap re-ask, so it annotates a transcript
  // rather than condemning it, leaving ADR 0030's exclusion rule (loud leaks
  // only) unchanged. Read alongside guardRetries to get fired-vs-survived.
  // Defaulted so pre-#422 rows parse.
  quietViolations: z
    .array(z.object({ speaker: z.string(), kinds: z.array(z.string()), snippet: z.string() }))
    .default([]),
  // Protocol-guard re-asks that fired DURING this couple's negotiation (issue
  // #422) — the retries themselves, distinct from protocolViolations above
  // (what still survived them). A firing with no matching surviving violation
  // means the retry worked; frequent firings on clean transcripts quantify the
  // guard's false-positive cost. Defaulted so pre-#422 rows parse.
  guardRetries: z.array(z.object({ speaker: z.string(), kinds: z.array(z.string()) })).default([]),
  judge: z.object({ score: z.number().nullable(), rationale: z.string().nullable() }),
  outcome: z.object({
    scoreA: z.number().int(),
    scoreB: z.number().int(),
    matched: z.boolean(),
    deltaA: z.number(),
    deltaB: z.number(),
    bandAgreement: z.boolean().optional(),
    // Per-side band verdicts (issue #422): bandAgreement rounds the MEAN, so a
    // borderline couple's clean 6/7 rounds up into the compatible band on one
    // point of noise. At the band edge these per-side bits are the finer
    // signal (docs/adr/0030). Optional so pre-#422 rows parse.
    bandAgreementA: z.boolean().optional(),
    bandAgreementB: z.boolean().optional(),
  }),
});
export type Track2LogRecord = z.infer<typeof Track2LogRecordSchema>;

export const Track2RunLogSchema = z.object({
  meta: z.object({
    startedAtIso: z.string(),
    barneyModel: z.string(),
    judgeModel: z.string(),
    turns: z.number().int(),
    seed: z.number().optional(),
    runIndex: z.number().int().optional(),
    costUsd: z.number(),
    durationMs: z.number(),
    // Total protocol-guard re-ask firings across every couple in this run
    // (issue #422) — the sum of each record's guardRetries.length, hoisted so
    // the guard's false-positive rate is auditable from meta alone. Optional
    // so pre-#422 logs parse.
    guardRetryCount: z.number().int().min(0).optional(),
  }),
  records: z.array(Track2LogRecordSchema),
});
export type Track2RunLog = z.infer<typeof Track2RunLogSchema>;
