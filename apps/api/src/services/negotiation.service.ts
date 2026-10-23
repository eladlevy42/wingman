import { prisma } from "@wingman/database";
import type { Match } from "@wingman/database";
import { UserProfileSchema, WantedProfileSchema } from "@wingman/shared";
import type { NegotiationResult } from "@wingman/shared";
import {
  runNegotiation,
  writeFallbackRationale,
  type NegotiationParticipant,
  type NegotiationConfig,
} from "../agents/negotiation.agent";
import { createMatch } from "./match.service";
import { mergeDeltas } from "./delta.service";

// Loads one participant's UserProfile + WantedProfile from the DB. Throws
// (rather than returning null, as matching.service's parseCandidate does) —
// callers already know this user should have a complete profile by the time
// they call negotiateAndPersist, so a missing/malformed one is a real error,
// not a candidate to silently skip.
// Exported for Track 2's eval runner (issue #250), which needs the raw
// NegotiationResult (cost/duration/transcript) that negotiateAndPersist below
// discards after persisting a Match.
export async function loadParticipant(userId: string): Promise<NegotiationParticipant> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true, wantedProfile: true },
  });
  if (!user) {
    throw new Error(`negotiateAndPersist: user ${userId} not found`);
  }
  if (!user.profile?.structuredData || !user.wantedProfile?.structuredData) {
    throw new Error(`negotiateAndPersist: user ${userId} has no completed profile`);
  }

  const profile = UserProfileSchema.parse(JSON.parse(user.profile.structuredData));
  const wanted = WantedProfileSchema.parse(JSON.parse(user.wantedProfile.structuredData));

  // Lessons from past Blind Dates (issue #299): merged here so every
  // negotiation — sweep, first-cycle trigger, and eval Track 2 alike — briefs
  // the agent with its human's most current dealbreakers/preferences. An
  // all-empty merge serializes to nothing downstream (formatProfileContext).
  const feedback = await mergeDeltas(user.id);

  return { userId: user.id, name: user.name, gender: user.gender, profile, wanted, feedback };
}

// Loads both users' profiles, runs the agent-to-agent negotiation (#40/#41),
// and persists the outcome (#42). Shared by #44 (orchestration) and #45
// (manual trigger) so DB profile loading isn't duplicated across both callers.
//
// onUsage (#307) is an optional hook the orchestration sweep uses to
// accumulate real Anthropic spend against SWEEP_BUDGET_USD — negotiateAndPersist
// itself stays a plain Match-returning function for its other callers (the
// manual /api/match/negotiate route, tests) rather than widening its return
// shape for a concern only the sweep guardrail cares about.
export async function negotiateAndPersist(
  userAId: string,
  userBId: string,
  config?: NegotiationConfig,
  onUsage?: (usage: { costUsd: number; durationMs: number }) => void
): Promise<Match> {
  const [a, b] = await Promise.all([loadParticipant(userAId), loadParticipant(userBId)]);
  const result = await runNegotiation(a, b, config);
  onUsage?.({ costUsd: result.costUsd, durationMs: result.durationMs });
  return createMatch(userAId, userBId, result);
}

// Best-available fallback (#chat-flow #8): pairs two users as MATCHED without a
// full agent negotiation, so a user who has no threshold-clearing candidate still
// ends onboarding with someone to meet rather than a dead-end "no match". The
// resulting Match is tagged matchType="FORCED" (#345) so it is queryably
// distinct from a genuine match; the modest 6/6 scores record that this pairing
// did NOT clear the normal mutual bar (MATCH_THRESHOLD is 7) — it is the system
// pairing the closest fit on purpose.
// A warm, honest rationale is generated so the Pitch page (which requires a
// non-null rationale) works exactly as it does for a genuine match.
export async function forceMatchAndPersist(userAId: string, userBId: string): Promise<Match> {
  const [a, b] = await Promise.all([loadParticipant(userAId), loadParticipant(userBId)]);
  const rationale = await writeFallbackRationale(a, b);
  const result: NegotiationResult = {
    deliberationLog: [
      {
        speaker: "system",
        content:
          "Best-available match: no candidate cleared the mutual score threshold, so Wingman " +
          "paired the closest fit so the user always has someone to meet.",
      },
    ],
    scoreA: 6,
    scoreB: 6,
    matched: true,
    rationale,
    // No per-agent saveScore call happens on this fallback path, so there is
    // no individual rationale to surface (issue #420).
    rationaleA: null,
    rationaleB: null,
    // No agent-to-agent negotiation happens here, so there's no real API spend
    // to report — the cost/duration fields main added for eval tracking are 0.
    costUsd: 0,
    durationMs: 0,
    // No negotiation turns ran, so the protocol guard (#422) never fired.
    guardRetries: [],
  };
  // Persist as FORCED (#345) so this best-available pairing is queryably
  // distinct from a genuine 6/6 negotiation, rather than inferred from the
  // scores or the `system` log line above.
  return createMatch(userAId, userBId, result, "FORCED");
}
