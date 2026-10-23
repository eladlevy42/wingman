import { prisma } from "@wingman/database";
import type { MatchAttempt, Match } from "@wingman/database";
import {
  MatchAttemptSummarySchema,
  MatchAttemptDetailSchema,
  NegotiationMessageSchema,
} from "@wingman/shared";
import type {
  CandidateScore,
  MatchAttemptSummary,
  MatchAttemptDetail,
  MatchAttemptFailure,
  NegotiationOutcome,
  StoppedReason,
} from "@wingman/shared";

export class MatchAttemptNotFoundError extends Error {
  constructor(id: string) {
    super(`No match attempt found with id ${id}`);
    this.name = "MatchAttemptNotFoundError";
  }
}

// listMatchAttempts is the #253 audit's list view — the diagnostic surface
// reached for exactly when something has gone wrong, so one malformed row
// must not take out the whole list (issue #382). A summary only needs
// array *lengths*, so a defensive parse that logs and falls back to 0 on
// malformed JSON is enough; the full detail view (getMatchAttempt) is
// unguarded on purpose — a malformed single item throwing for that one id
// is acceptable.
function safeJsonArrayLength(
  raw: string,
  rowId: string,
  field: "candidateScores" | "matchIds"
): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length;
    console.error(
      `matchAttempt.service: ${field} on attempt ${rowId} did not parse to an array`,
      typeof parsed
    );
    return 0;
  } catch (error) {
    console.error(`matchAttempt.service: malformed ${field} JSON on attempt ${rowId}`, error);
    return 0;
  }
}

// List-view variant: like toSummary but never throws. A row with a corrupted
// scalar column (status/id/createdAt) that fails MatchAttemptSummarySchema.parse
// would otherwise take out the whole list — the same failure class #382 targets
// for the JSON columns. Such a row is skipped (logged), so the rest of the list
// still renders, consistent with the safeJsonArrayLength fallback-to-0 approach.
function toSummaryOrNull(row: MatchAttempt): MatchAttemptSummary | null {
  const candidateCount = safeJsonArrayLength(row.candidateScores, row.id, "candidateScores");
  const negotiatedCount = safeJsonArrayLength(row.matchIds, row.id, "matchIds");
  try {
    return toSummaryFromCounts(row, candidateCount, negotiatedCount);
  } catch (error) {
    console.error(`matchAttempt.service: skipping malformed attempt row ${row.id}`, error);
    return null;
  }
}

function toSummaryFromCounts(
  row: MatchAttempt,
  candidateCount: number,
  negotiatedCount: number
): MatchAttemptSummary {
  return MatchAttemptSummarySchema.parse({
    id: row.id,
    userId: row.userId,
    status: row.status,
    candidateCount,
    negotiatedCount,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

function toNegotiationOutcome(match: Match, candidateId: string): NegotiationOutcome {
  return {
    matchId: match.id,
    candidateId,
    status: match.status as "PENDING" | "MATCHED" | "REJECTED",
    scoreA: match.scoreA,
    scoreB: match.scoreB,
    deliberationLog: match.deliberationLog
      ? NegotiationMessageSchema.array().parse(JSON.parse(match.deliberationLog))
      : [],
    rationale: match.rationale,
  };
}

// How many of this user's past cycles ended EXHAUSTED (#301) — the grace
// period's clock for the best-available force-match fallback. The current
// attempt row already exists (as RUNNING) when this runs, but it's excluded
// from the count because its status isn't EXHAUSTED yet, so this only
// reflects prior cycles.
export async function countExhaustedAttempts(userId: string): Promise<number> {
  return prisma.matchAttempt.count({ where: { userId, status: "EXHAUSTED" } });
}

// Starts a match attempt row — called at the top of matchOneUser
// (orchestration.service.ts), before any candidate is negotiated, so a
// live-in-progress attempt is visible to GET /api/match-attempts/:id
// immediately (status "RUNNING") rather than only appearing once finished.
export async function createMatchAttempt(
  userId: string,
  candidateScores: CandidateScore[]
): Promise<MatchAttempt> {
  return prisma.matchAttempt.create({
    data: {
      userId,
      status: "RUNNING",
      candidateScores: JSON.stringify(candidateScores),
    },
  });
}

// Closes out a match attempt once matchOneUser's negotiation loop (and,
// possibly, the best-available fallback) finishes — a match was negotiated,
// one was forced via the fallback (#315), the shortlist (possibly empty) was
// exhausted with no fallback candidate either, or either a negotiation turn
// threw (#339) or an unexpected error hit before any turn ran (#378) — status
// "FAILED" either way, `failure` is required in that case and carries the
// log, error message, and which of the two sub-cases it was.
export async function completeMatchAttempt(
  attemptId: string,
  status: "MATCHED" | "EXHAUSTED" | "FORCED" | "FAILED",
  matchIds: string[],
  failure?: MatchAttemptFailure,
  // Set when the shortlist walk stopped early (#307) — e.g. SWEEP_BUDGET_USD
  // tripped mid-walk — rather than exhausting every shortlisted candidate.
  stoppedReason?: StoppedReason
): Promise<void> {
  await prisma.matchAttempt.update({
    where: { id: attemptId },
    data: {
      status,
      matchIds: JSON.stringify(matchIds),
      failureLog: failure ? JSON.stringify(failure.log) : null,
      failureError: failure ? failure.error : null,
      failureReason: failure ? failure.reason : null,
      stoppedReason: stoppedReason ?? null,
      completedAt: new Date(),
    },
  });
}

export async function listMatchAttempts(
  userId?: string,
  limit = 50
): Promise<MatchAttemptSummary[]> {
  const rows = await prisma.matchAttempt.findMany({
    where: userId ? { userId } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows
    .map(toSummaryOrNull)
    .filter((summary): summary is MatchAttemptSummary => summary !== null);
}

// Full pipeline view for one attempt (issue #253): the deterministic-filter
// stage's scored candidate pool, plus each negotiated candidate's outcome —
// joined from the Match rows matchIds references, in negotiation order.
export async function getMatchAttempt(attemptId: string): Promise<MatchAttemptDetail> {
  const row = await prisma.matchAttempt.findUnique({ where: { id: attemptId } });
  if (!row) throw new MatchAttemptNotFoundError(attemptId);

  const candidateScores = JSON.parse(row.candidateScores) as CandidateScore[];
  const matchIds = JSON.parse(row.matchIds) as string[];

  const matches =
    matchIds.length > 0 ? await prisma.match.findMany({ where: { id: { in: matchIds } } }) : [];
  const matchById = new Map(matches.map((m) => [m.id, m]));

  const negotiations: NegotiationOutcome[] = [];
  for (const matchId of matchIds) {
    const match = matchById.get(matchId);
    if (!match) continue; // defensive — a referenced Match row should always exist
    const candidateId = match.userAId === row.userId ? match.userBId : match.userAId;
    negotiations.push(toNegotiationOutcome(match, candidateId));
  }

  const failure: MatchAttemptFailure | null =
    typeof row.failureLog === "string" && typeof row.failureError === "string"
      ? {
          log: NegotiationMessageSchema.array().parse(JSON.parse(row.failureLog)),
          error: row.failureError,
          // Rows persisted before #378 predate this column and default to
          // "negotiation_turn", the only FAILED sub-case that existed then.
          reason: (row.failureReason as MatchAttemptFailure["reason"] | null) ?? "negotiation_turn",
        }
      : null;

  return MatchAttemptDetailSchema.parse({
    ...toSummaryFromCounts(row, candidateScores.length, matchIds.length),
    candidateScores,
    negotiations,
    failure,
    stoppedReason: (row.stoppedReason as StoppedReason | null) ?? null,
  });
}
