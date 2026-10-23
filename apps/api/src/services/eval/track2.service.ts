import { prisma } from "@wingman/database";
import { bandAgreement, GoldenPairCategorySchema, Track2ResultSchema } from "@wingman/shared";
import type { Track2Groundedness, Track2Result, Track2LogRecord } from "@wingman/shared";
import {
  runNegotiation,
  serializeParticipantProfile,
  type NegotiationParticipant,
} from "../../agents/negotiation.agent";
import { judgeNegotiation } from "../../agents/evalJudge.agent";
import { judgeDealbreakerConsistency } from "../../agents/consistencyJudge.agent";
import {
  judgeGroundedness,
  judgeCrossGroundedness,
  type GroundednessResult,
} from "../../agents/groundednessJudge.agent";
import { EVAL_MODEL_IDS } from "../../agents/models";
import { loadParticipant } from "../negotiation.service";
import { createMatch } from "../match.service";
import { sample } from "./sample";
import { buildTrack2LogRecord } from "./track2Log";
import type { EvalRunContext } from "./types";

function formatTranscript(deliberationLog: { speaker: string; content: string }[]): string {
  return deliberationLog.map((m) => `${m.speaker}: ${m.content}`).join("\n\n");
}

// runNegotiation labels each message `${participant.name}'s agent`.
function speakerLabel(participant: NegotiationParticipant): string {
  return `${participant.name}'s agent`;
}

// Grades both agents' claims against their own humans' profiles (issue #336),
// PLUS each agent's claims about the OTHER human against that other human's
// profile (issue #420 — catches fabrications like calling a chef a "software
// engineer" that the self-only passes can never see), and folds all four
// per-speaker verdicts into one per-pair summary.
async function judgePairGroundedness(
  a: NegotiationParticipant,
  b: NegotiationParticipant,
  deliberationLog: { speaker: string; content: string }[],
  model: string
): Promise<GroundednessResult & { groundedness: Track2Groundedness }> {
  const claimsOf = (participant: NegotiationParticipant) =>
    deliberationLog.filter((m) => m.speaker === speakerLabel(participant)).map((m) => m.content);

  const [gA, gB, crossA, crossB] = await Promise.all([
    judgeGroundedness(a.name, serializeParticipantProfile(a), claimsOf(a), model),
    judgeGroundedness(b.name, serializeParticipantProfile(b), claimsOf(b), model),
    // A's claims ABOUT B, checked against B's own profile.
    judgeCrossGroundedness(a.name, b.name, serializeParticipantProfile(b), claimsOf(a), model),
    // B's claims ABOUT A, checked against A's own profile.
    judgeCrossGroundedness(b.name, a.name, serializeParticipantProfile(a), claimsOf(b), model),
  ]);

  // Self-claims and about-other-claims are disjoint claim populations (a
  // "factual claim about the human" vs. a "factual claim about the other
  // human" cannot be the same statement), so summing all four passes'
  // totalClaims does not double-count.
  const totalClaims = gA.totalClaims + gB.totalClaims + crossA.totalClaims + crossB.totalClaims;
  const flags = [
    ...gA.ungroundedClaims.map((flag) => ({
      ...flag,
      speaker: speakerLabel(a),
      kind: "self" as const,
    })),
    ...gB.ungroundedClaims.map((flag) => ({
      ...flag,
      speaker: speakerLabel(b),
      kind: "self" as const,
    })),
    // A said it, about B — attributed to A (the speaker), not B.
    ...crossA.ungroundedClaims.map((flag) => ({
      ...flag,
      speaker: speakerLabel(a),
      kind: "about-other" as const,
    })),
    // B said it, about A — attributed to B.
    ...crossB.ungroundedClaims.map((flag) => ({
      ...flag,
      speaker: speakerLabel(b),
      kind: "about-other" as const,
    })),
  ];

  return {
    totalClaims,
    ungroundedClaims: flags,
    costUsd: gA.costUsd + gB.costUsd + crossA.costUsd + crossB.costUsd,
    durationMs: gA.durationMs + gB.durationMs + crossA.durationMs + crossB.durationMs,
    groundedness: {
      totalClaims,
      ungroundedCount: flags.length,
      ungroundedRate: totalClaims > 0 ? flags.length / totalClaims : 0,
      flags,
    },
  };
}

export interface Track2RunOutput {
  result: Track2Result;
  logRecords: Track2LogRecord[];
}

export async function runTrack2(ctx: EvalRunContext): Promise<Track2RunOutput> {
  const goldenPairs = await prisma.goldenPair.findMany();
  const selected = sample(goldenPairs, ctx.config.count, ctx.config.seed);
  const barneyModel = EVAL_MODEL_IDS[ctx.config.barneyModel];
  const judgeModel = EVAL_MODEL_IDS[ctx.config.judgeModel];

  const results: Track2Result = [];
  const logRecords: Track2LogRecord[] = [];

  for (let i = 0; i < selected.length; i++) {
    if (ctx.shouldStop()) break;
    const pair = selected[i];

    const start = Date.now();
    const [a, b] = await Promise.all([
      loadParticipant(pair.userAId),
      loadParticipant(pair.userBId),
    ]);
    const negotiation = await runNegotiation(a, b, {
      turns: ctx.config.turns,
      model: barneyModel,
      captureThinking: ctx.config.captureThinking,
      // Alternate the opener per couple so the first-mover advantage averages
      // out of the aggregate meanA/meanB instead of always favoring A (#420,
      // P7b). Deterministic by index, so a fixed seed still reproduces a run.
      openerSide: i % 2 === 0 ? "a" : "b",
    });
    // Persists a real Match row, same as the production negotiation flow —
    // pre-existing behavior, kept so Track 2 runs are visible in the app's
    // own match history, not just the eval dashboard.
    await createMatch(pair.userAId, pair.userBId, negotiation);

    const [judge, consistency, groundedness] = await Promise.all([
      judgeNegotiation(negotiation.deliberationLog, judgeModel),
      judgeDealbreakerConsistency(
        negotiation.deliberationLog,
        `${a.name}'s agent`,
        negotiation.scoreA,
        `${b.name}'s agent`,
        negotiation.scoreB,
        judgeModel
      ),
      judgePairGroundedness(a, b, negotiation.deliberationLog, judgeModel),
    ]);
    const durationMs = Date.now() - start;
    const costUsd =
      negotiation.costUsd + judge.costUsd + consistency.costUsd + groundedness.costUsd;

    // Headline accuracy metric (#398): did the engine's outcome land in the
    // golden category's band? Uses the mean of both agents' scores, so it is
    // immune to the A/B asymmetry a per-side point-target delta conflates.
    // safeParse, not parse: GoldenPair.category is a raw String column, and by
    // this point the pair's (paid) negotiation and judge calls have already
    // run — a corrupted category must degrade to "no band verdict" for this
    // pair, not throw away the whole run's accumulated results. The schema
    // fields are optional, so a missing verdict parses fine downstream.
    const categoryParsed = GoldenPairCategorySchema.safeParse(pair.category);
    if (!categoryParsed.success) {
      console.error(
        `track2: golden pair ${pair.id} has invalid category "${pair.category}" — skipping band verdict`
      );
    }
    const category = categoryParsed.success ? categoryParsed.data : undefined;
    const engineMeanScore = (negotiation.scoreA + negotiation.scoreB) / 2;
    // Per-side band verdicts (#422): the mean-based bit above rounds a
    // borderline couple's 6/7 up into the compatible band on one point of
    // noise; at the band edge each side's own verdict is the finer signal.
    const bandAgreementA =
      category === undefined ? undefined : bandAgreement(category, negotiation.scoreA);
    const bandAgreementB =
      category === undefined ? undefined : bandAgreement(category, negotiation.scoreB);

    results.push({
      pairId: pair.id,
      goldenScore: pair.goldenScore,
      category,
      bandAgreement: category === undefined ? undefined : bandAgreement(category, engineMeanScore),
      bandAgreementA,
      bandAgreementB,
      scoreA: negotiation.scoreA,
      scoreB: negotiation.scoreB,
      deltaA: negotiation.scoreA - pair.goldenScore,
      deltaB: negotiation.scoreB - pair.goldenScore,
      matched: negotiation.matched,
      judgeScore: judge.score,
      judgeRationale: judge.rationale,
      dealbreakerConsistency: {
        aDealbreakerViolated: consistency.aDealbreakerViolated,
        aConsistent: consistency.aConsistent,
        bDealbreakerViolated: consistency.bDealbreakerViolated,
        bConsistent: consistency.bConsistent,
        explanation: consistency.explanation,
      },
      groundedness: groundedness.groundedness,
      transcript: formatTranscript(negotiation.deliberationLog),
      costUsd,
      durationMs,
    });

    const groundednessFlagsA = groundedness.groundedness.flags.filter(
      (f) => f.speaker === speakerLabel(a)
    );
    const groundednessFlagsB = groundedness.groundedness.flags.filter(
      (f) => f.speaker === speakerLabel(b)
    );
    const logRecord = buildTrack2LogRecord({
      pair: {
        id: pair.id,
        userAId: pair.userAId,
        userBId: pair.userBId,
        goldenScore: pair.goldenScore,
        category: pair.category,
      },
      nameA: a.name,
      nameB: b.name,
      negotiation,
      groundednessA: groundednessFlagsA,
      groundednessB: groundednessFlagsB,
      totalClaims: groundedness.groundedness.totalClaims,
      consistency,
      judgeScore: judge.score,
      judgeRationale: judge.rationale,
      deltaA: negotiation.scoreA - pair.goldenScore,
      deltaB: negotiation.scoreB - pair.goldenScore,
      bandAgreement: category === undefined ? undefined : bandAgreement(category, engineMeanScore),
      bandAgreementA,
      bandAgreementB,
    });
    logRecords.push(logRecord);
    if (logRecord.protocolViolations.length > 0) {
      // Surfaced live so a contaminated case (leaked score / staged turn that
      // survived the turn-level retry) is visible during the run and can be
      // discarded from calibration rather than silently trusted (#420).
      console.warn(
        `track2: pair ${pair.id} transcript CONTAMINATED — ${logRecord.protocolViolations
          .map((v) => `[${v.speaker}] ${v.kinds.join(",")}`)
          .join("; ")}`
      );
    }
    if (logRecord.quietViolations.length > 0) {
      // Deliberately NOT labelled CONTAMINATED (#422): quiet ventriloquism that
      // survived the retry is worth reading before trusting a transcript, but
      // this detector is a structural heuristic and does not condemn a case on
      // its own. See CONTAMINATING_VIOLATION_KINDS.
      console.warn(
        `track2: pair ${pair.id} quiet ventriloquism survived the retry — ${logRecord.quietViolations
          .map((v) => `[${v.speaker}] ${v.kinds.join(",")}`)
          .join("; ")}`
      );
    }
    // Flush this couple's record before starting the next negotiation, so a
    // crash mid-run preserves the couples already done (issue #420).
    await ctx.onRecord?.(logRecord);

    const inconsistent = !consistency.aConsistent || !consistency.bConsistent;
    ctx.onCase({
      index: i + 1,
      total: selected.length,
      costUsd,
      durationMs,
      score: (negotiation.scoreA + negotiation.scoreB + judge.score) / 30,
      summary: `A ${negotiation.scoreA} · B ${negotiation.scoreB} · judge ${judge.score} — ${negotiation.matched ? "matched" : "not matched"}${inconsistent ? " — dealbreaker cap inconsistency" : ""}`,
    });
  }

  return { result: Track2ResultSchema.parse(results), logRecords };
}
