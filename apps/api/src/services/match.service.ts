import { prisma } from "@wingman/database";
import type { Match } from "@wingman/database";
import type { MatchType, NegotiationResult } from "@wingman/shared";
import { recordEvent } from "./audit.service";

// Canonical source for these two errors — barney.service.ts re-exports them
// rather than defining its own, since it already depends on this module.
export class MatchNotFoundError extends Error {}
export class MatchOwnershipError extends Error {}

// Persists the outcome of a negotiation (#41) to the Match table. This is the
// only writer of Match records today — see docs/adr/0010 — so scoreA/scoreB
// are always present by construction.
// `matchType` (#345) distinguishes a genuine negotiation from the
// best-available fallback; it defaults to NEGOTIATED so every normal caller
// (negotiateAndPersist, eval Track 2) records a negotiated match, and only
// forceMatchAndPersist passes "FORCED".
export async function createMatch(
  userAId: string,
  userBId: string,
  result: NegotiationResult,
  matchType: MatchType = "NEGOTIATED"
): Promise<Match> {
  return prisma.match.create({
    data: {
      userAId,
      userBId,
      status: result.matched ? "MATCHED" : "REJECTED",
      matchType,
      scoreA: result.scoreA,
      scoreB: result.scoreB,
      deliberationLog: JSON.stringify(result.deliberationLog),
      rationale: result.rationale,
    },
  });
}

// Looks up a single Match by id — used by the pitch session route (#52) to
// read the rationale to inject into BarneyAgent. Returns null for an unknown
// id rather than throwing; the caller (barney.service.ts) decides how to
// surface that (see docs/adr/0014).
export async function getMatchById(matchId: string): Promise<Match | null> {
  return prisma.match.findUnique({ where: { id: matchId } });
}

// Records a user's post-pitch Yeah/Nah decision (#56). Idempotent: a second
// call for the same user/match is ignored, so a user cannot flip their
// decision or reset the decidedAt timestamp by re-submitting.
export async function decideMatch(
  matchId: string,
  userId: string,
  decision: "yeah" | "nah"
): Promise<{ waiting: boolean }> {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    throw new MatchNotFoundError(`No match found for id ${matchId}`);
  }

  const isUserA = match.userAId === userId;
  const isUserB = match.userBId === userId;
  if (!isUserA && !isUserB) {
    throw new MatchOwnershipError(`User ${userId} is not a participant in match ${matchId}`);
  }

  // Guarded single UPDATE instead of a JS-level read-then-write: the WHERE
  // clause (decisionA/decisionB still null) is evaluated atomically by the
  // database, so two concurrent calls for the same user (double-submit,
  // retry-on-timeout) can't both observe "not yet decided" and both write —
  // only the first one's guard matches.
  const { count } = await prisma.match.updateMany({
    where: isUserA ? { id: matchId, decisionA: null } : { id: matchId, decisionB: null },
    data: isUserA
      ? { decisionA: decision, decidedAtA: new Date() }
      : { decisionB: decision, decidedAtB: new Date() },
  });
  // Only the write that landed is a decision — the idempotence guard's loser
  // (re-submit, retry) decided nothing, so it records nothing (#552).
  if (count > 0) {
    await recordEvent("PITCH_DECIDED", { matchId, decision }, { userId });
  }

  const current = await prisma.match.findUnique({ where: { id: matchId } });
  const otherDecided = isUserA ? current?.decisionB != null : current?.decisionA != null;
  return { waiting: !otherDecided };
}
