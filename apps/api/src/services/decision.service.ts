import { prisma, DELETED_USER_ID } from "@wingman/database";
import type { Match } from "@wingman/database";
import type { MatchingStateSchema } from "@wingman/shared";
import type { z } from "zod";
import { cooldownMs, decisionWindowMs } from "./orchestration.service";
import { startTimeSelection, scheduleFallback } from "./scheduling.service";
import { recordEvent } from "./audit.service";

// The decision window is anchored to whichever user decided first — once one
// user responds, the other has one Decision Window (DECISION_WINDOW_MINUTES,
// falling back to a fixed 60-minute default when unset, blank, or invalid —
// independent of MATCH_COOLDOWN_MINUTES — #302, #381, docs/adr/0024) to catch
// up before non-response is treated as Nah (PRODUCT_SPEC.md §6, issue #57).
// If neither has decided yet, there's no "first decision" to anchor from, so
// the window falls back to match creation — otherwise a fully-silent match
// would never expire.
function decisionWindowAnchor(match: Match): Date {
  const decidedTimestamps = [match.decidedAtA, match.decidedAtB].filter(
    (d): d is Date => d != null
  );
  if (decidedTimestamps.length === 0) return match.createdAt;
  return decidedTimestamps.reduce((earliest, d) => (d < earliest ? d : earliest));
}

function isWindowExpired(match: Match): boolean {
  return Date.now() - decisionWindowAnchor(match).getTime() >= decisionWindowMs();
}

/**
 * Rejects a match and returns both participants to WAITING.
 *
 * Exported for the account-erasure path (userDeletion.service, docs/adr/0040):
 * a user who deletes mid-cycle can never answer, and their counterparty must be
 * released rather than left holding a match against a tombstone.
 */
export async function rejectMatch(match: Match): Promise<void> {
  // Guarded on status still being MATCHED: resolveMatchById (fired from the
  // decide route) and the resolver sweep can both read the same match before
  // either flips it. The loser used to be harmlessly idempotent; now that the
  // rejection writes audit events, it must be a true no-op — otherwise it
  // reads users already reset to WAITING and records a false
  // WAITING -> WAITING transition per user (#552).
  const { count } = await prisma.match.updateMany({
    where: { id: match.id, status: "MATCHED" },
    data: { status: "REJECTED" },
  });
  if (count === 0) return;

  // The users' prior states differ by where the match died — MATCHED before
  // times were offered, CHOOSING_TIMES after — so read them before the write
  // rather than guessing, and record the audit transition per user (#552).
  // One side of this match may be the deleted-user tombstone (docs/adr/0040),
  // which is not a person to move back into the queue. Filtering the id list
  // once keeps it out of the write below and out of the audit loop, which reads
  // from this result.
  const participantIds = [match.userAId, match.userBId].filter((id) => id !== DELETED_USER_ID);
  const priorStates = await prisma.user.findMany({
    where: { id: { in: participantIds } },
    select: { id: true, matchingState: true },
  });

  // enteredWaitingAt is reset here so the sweep's fairness ordering (#343)
  // reflects this re-entry, not the account's original createdAt.
  await prisma.user.updateMany({
    where: { id: { in: participantIds } },
    data: { matchingState: "WAITING", enteredWaitingAt: new Date() },
  });

  for (const prior of priorStates) {
    await recordEvent(
      "MATCHING_STATE_CHANGED",
      {
        // The column is a plain string in SQLite; recordEvent re-validates
        // against MatchingStateSchema and drops anything malformed.
        from: prior.matchingState as z.infer<typeof MatchingStateSchema>,
        to: "WAITING",
        trigger: "match_rejected",
        matchId: match.id,
      },
      { userId: prior.id }
    );
  }
}

// Resolves one match still awaiting a final outcome (docs/PRODUCT_SPEC.md §6,
// extended by #248): either decision is Nah -> reject immediately; both Yeah ->
// move into the choose-your-times step, then schedule the Blind Date once both
// users have picked their times. Non-response past the decision window is
// treated as Nah before times are offered, and as "schedule with whatever we
// have" once the match is already choosing times — so a silent user can never
// strand a mutually-accepted match.
async function resolveOneMatch(match: Match): Promise<void> {
  if (match.decisionA === "nah" || match.decisionB === "nah") {
    await rejectMatch(match);
    return;
  }
  if (match.decisionA === "yeah" && match.decisionB === "yeah") {
    if (!match.candidateSlots) {
      await startTimeSelection(match);
      return;
    }
    // The chooser's pick schedules the date synchronously (scheduling.service);
    // the resolver only steps in once the decision window has expired without a
    // completed pick, auto-scheduling so a silent user can't strand the match.
    if (isWindowExpired(match)) {
      await scheduleFallback(match.id);
    }
    return;
  }
  if (isWindowExpired(match)) {
    await rejectMatch(match);
  }
}

// Resolves a single match immediately by id, so the Pitch decision and the
// choose-times submission can advance the flow without waiting for the next
// sweep. Silently ignores matches that aren't in a resolvable state.
export async function resolveMatchById(matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (match && match.status === "MATCHED" && !match.venue) {
    await resolveOneMatch(match);
  }
}

let isRunning = false;

// One resolver sweep: every negotiated match not yet resolved to a Blind Date
// (venue still null) is checked against the outcomes above. A failure for one
// match is logged and does not stop the rest of the sweep. Skips entirely if
// the previous sweep is still running rather than overlapping with it.
export async function runDecisionResolverTick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const pending = await prisma.match.findMany({
      where: { status: "MATCHED", venue: null },
    });

    for (const match of pending) {
      try {
        await resolveOneMatch(match);
      } catch (error) {
        console.error(`decision: failed to resolve match ${match.id}:`, error);
      }
    }
  } catch (error) {
    console.error("decision: resolver tick failed:", error);
  } finally {
    isRunning = false;
  }
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;

export function startDecisionResolverLoop(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runDecisionResolverTick();
  }, cooldownMs());
}

export function stopDecisionResolverLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
