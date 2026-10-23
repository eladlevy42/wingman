import { prisma, DELETED_USER_ID } from "@wingman/database";
import type { Match } from "@wingman/database";
import type { MatchAttemptFailure, StoppedReason } from "@wingman/shared";
import {
  scoreCandidates,
  bestAvailableCandidateId,
  recentlyRejectedCandidateIds,
  previouslyMatchedCandidateIds,
} from "./matching.service";
import { negotiateAndPersist, forceMatchAndPersist } from "./negotiation.service";
import { recordEvent } from "./audit.service";
import { NegotiationTurnFailure } from "../agents/negotiation.agent";
import { notificationService } from "./notification.service";
import {
  createMatchAttempt,
  completeMatchAttempt,
  countExhaustedAttempts,
} from "./matchAttempt.service";
import { withTimeout, TimeoutError } from "../lib/withTimeout";

const MS_PER_MINUTE = 60 * 1000;

export function cooldownMs(): number {
  const raw = process.env.MATCH_COOLDOWN_MINUTES;
  const minutes = Number(raw ?? "1");
  if (!Number.isFinite(minutes) || minutes <= 0) {
    if (raw !== undefined) {
      console.warn(
        `orchestration: invalid MATCH_COOLDOWN_MINUTES="${raw}", falling back to 1 minute`
      );
    }
    return MS_PER_MINUTE;
  }
  return minutes * MS_PER_MINUTE;
}

// The human clock (#302, docs/adr/0024): how long a person gets to respond
// before the system acts on their silence — the Yeah/Nah decision window, the
// choose-times fallback, and the pre-date reminder window. Unset, blank, or
// invalid values fall back to this fixed, generous default rather than
// MATCH_COOLDOWN_MINUTES (issue #381) — coupling a human's response window to
// the machine sweep cadence meant a real person got auto-Nah'd 60 seconds
// after the pitch whenever the cadence was left at its 1-minute dev default.
// Sweep cadences and candidate-slot spacing stay on cooldownMs() — those are
// machine-paced, not waits on a human.
const DEFAULT_DECISION_WINDOW_MINUTES = 60;

export function decisionWindowMs(): number {
  const raw = process.env.DECISION_WINDOW_MINUTES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DECISION_WINDOW_MINUTES * MS_PER_MINUTE;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.warn(
      `orchestration: invalid DECISION_WINDOW_MINUTES="${raw}", falling back to ${DEFAULT_DECISION_WINDOW_MINUTES} minutes`
    );
    return DEFAULT_DECISION_WINDOW_MINUTES * MS_PER_MINUTE;
  }
  return minutes * MS_PER_MINUTE;
}

// Grace period (#301) before the best-available force-match fallback is
// allowed to fire for a guaranteed cycle (onboarding's first cycle, the
// manual find-match button): how many of a user's prior cycles must have
// ended EXHAUSTED first. A brand-new user with a quiet WAITING pool gets a
// few passive sweeps to find a genuine threshold-clearing match before the
// fallback ignores hard criteria on their behalf. 0 disables the grace
// period entirely — the fallback fires on the very first guaranteed cycle,
// same as before this issue.
const DEFAULT_FORCE_MATCH_AFTER_SWEEPS = 3;

export function forceMatchAfterSweeps(): number {
  const raw = process.env.FORCE_MATCH_AFTER_SWEEPS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_FORCE_MATCH_AFTER_SWEEPS;
  const sweeps = Number(raw);
  if (!Number.isFinite(sweeps) || sweeps < 0 || !Number.isInteger(sweeps)) {
    console.warn(
      `orchestration: invalid FORCE_MATCH_AFTER_SWEEPS="${raw}", falling back to ${DEFAULT_FORCE_MATCH_AFTER_SWEEPS}`
    );
    return DEFAULT_FORCE_MATCH_AFTER_SWEEPS;
  }
  // Normalizes a "-0" input to 0 — Number.isInteger(-0) is true and -0 < 0 is
  // false, so it otherwise passes validation as a distinct value.
  return sweeps === 0 ? 0 : sweeps;
}

// Generous default (#307): a full negotiation is up to 8 turns plus 2 scoring
// calls and a rationale — up to 11 Agent SDK calls, each with its own bounded
// retry (agentSdkClient.ts's MAX_ATTEMPTS, up to ~31s of backoff on transient
// errors) before ever throwing — so a legitimate negotiation can occupy
// several minutes under retries alone. This only needs to catch a genuinely
// hung subprocess (a call that never resolves), not tune normal-case latency.
const DEFAULT_NEGOTIATION_TIMEOUT_MINUTES = 5;

export function negotiationTimeoutMs(): number {
  const raw = process.env.NEGOTIATION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_NEGOTIATION_TIMEOUT_MINUTES * MS_PER_MINUTE;
  }
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    console.warn(
      `orchestration: invalid NEGOTIATION_TIMEOUT_MS="${raw}", falling back to ${DEFAULT_NEGOTIATION_TIMEOUT_MINUTES} minutes`
    );
    return DEFAULT_NEGOTIATION_TIMEOUT_MINUTES * MS_PER_MINUTE;
  }
  return ms;
}

// Sweep-wide spend circuit breaker (#307). `null` (SWEEP_BUDGET_USD unset,
// blank, or invalid) means uncapped — current dev/demo behavior is unchanged
// until an operator opts in. Mirrors the eval dashboard's budgetCapUsd
// semantics (EvalRunConfig, #250): once this many real dollars have been
// spent across the whole sweep/cycle, no further candidate gets negotiated —
// the remaining shortlist, and the guarantee/failure fallback, wait for the
// next tick instead.
export function sweepBudgetUsd(): number | null {
  const raw = process.env.SWEEP_BUDGET_USD;
  if (raw === undefined || raw.trim() === "") return null;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) {
    console.warn(
      `orchestration: invalid SWEEP_BUDGET_USD="${raw}", disabling the sweep budget cap`
    );
    return null;
  }
  return usd;
}

// Accumulates real Anthropic spend across every user matchOneUser processes
// within one sweep/cycle (#307) — a plain mutable counter rather than a
// class, since only one field is ever read or written. Each top-level entry
// point (runOrchestrationTick, triggerFirstMatchCycle, startMatchCycle)
// creates its own fresh tracker, so the cap always applies to "this
// sweep/cycle's spend", never spend carried over from an earlier tick.
export interface SweepBudget {
  spentUsd: number;
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;
let isRunning = false;

// One user's attempt, shared by all three entry points below: the interval
// sweep (runOrchestrationTick), the immediate first-cycle trigger fired right
// after Phase 2 completes (triggerFirstMatchCycle), and the manual find-match
// button (startMatchCycle).
//
// Two-stage matching (docs/adr/0006): deterministicFilter cheaply ranks the
// entire population down to this user's few most-alike candidates without any
// AI. Only that shortlist is worth the cost of an agent-to-agent negotiation,
// so we walk it best-first and run the AI on each until both agents endorse a
// pair. A rejection leaves both users WAITING, so we simply move on to the
// next candidate; if none of the shortlist matches, the user stays WAITING for
// a later cycle. Stops at the first MATCHED pair.
//
// guaranteeMatch (#376): true only for the manual button and onboarding's
// first cycle — the two callers the "never dead-end" guarantee (#chat-flow
// #8) is meant for. The passive sweep leaves it false, so an exhausted
// shortlist with no guarantee simply ends the attempt EXHAUSTED rather than
// force-pairing the user with the best-available candidate as a matter of
// course; see the guaranteeMatch/failure gate below the negotiation loop.
async function matchOneUser(
  userId: string,
  processedIds?: Set<string>,
  guaranteeMatch = false,
  budget?: SweepBudget
): Promise<void> {
  if (processedIds?.has(userId)) return;
  // The deleted-user tombstone is never a seeker (docs/adr/0040). Checked here
  // rather than only in the sweep's query because POST /:id/trigger-match
  // reaches this function with any id that resolves to a User row, and the
  // tombstone is one.
  if (userId === DELETED_USER_ID) return;

  const current = await prisma.user.findUnique({ where: { id: userId } });
  if (!current || current.matchingState !== "WAITING") return;

  // Full scored candidate pool (issue #253) — deterministicFilter's shortlist
  // is just the rank-not-null subset of this, sorted; recomputing it here
  // lets one attempt persist both "who was shortlisted" and "why everyone
  // else wasn't" without scoring the population twice.
  const candidateScores = await scoreCandidates(userId);
  const candidateIds = candidateScores
    .filter((s): s is typeof s & { rank: number } => s.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((s) => s.candidateId);

  processedIds?.add(userId);

  // Persisted even when the shortlist is empty — EXHAUSTED-with-zero-candidates
  // is itself diagnostic (issue #253's audit page shows *why* nobody was
  // eligible this cycle, via candidateScores' failure reasons). The try/finally
  // below always closes the attempt out; unlike the original #253 flow we do
  // NOT early-return on an empty shortlist, so the #chat-flow #8 best-available
  // fallback still runs and an empty shortlist never dead-ends the user.
  const attempt = await createMatchAttempt(userId, candidateScores);
  const matchIds: string[] = [];
  // Set only when a negotiation turn threw a NegotiationTurnFailure (#339); its
  // presence forces the attempt's final status to FAILED and carries the
  // partial transcript + error onto the record.
  let failure: MatchAttemptFailure | undefined;
  // Set when the shortlist walk stopped early instead of exhausting every
  // candidate (#307) — currently only the sweep budget cap does this.
  let stoppedReason: StoppedReason | undefined;

  const budgetCapUsd = sweepBudgetUsd();
  const budgetExhausted = (): boolean =>
    budgetCapUsd !== null && (budget?.spentUsd ?? 0) >= budgetCapUsd;

  try {
    for (const candidateId of candidateIds) {
      // Circuit breaker (#307): stop walking the shortlist once this
      // sweep/cycle has spent past SWEEP_BUDGET_USD, leaving this candidate
      // (and any after it) untried and the user WAITING for the next tick.
      if (budgetExhausted()) {
        stoppedReason = "sweep_budget";
        console.warn(
          `orchestration: sweep budget ($${budgetCapUsd}) reached — stopping ${userId}'s shortlist walk early, leaving them WAITING`
        );
        break;
      }

      // A candidate may have paired off since the filter ran — with this
      // user's earlier sweep-mate, or in a prior iteration of this loop — so
      // re-check WAITING right before negotiating and skip anyone no longer
      // available.
      const candidate = await prisma.user.findUnique({ where: { id: candidateId } });
      if (!candidate || candidate.matchingState !== "WAITING") continue;

      let match: Match;
      try {
        // Read once per negotiation: negotiationTimeoutMs() warns on an invalid
        // NEGOTIATION_TIMEOUT_MS, so calling it again for the message would log
        // that warning twice for every negotiation in the sweep.
        const timeoutMs = negotiationTimeoutMs();
        match = await withTimeout(
          negotiateAndPersist(userId, candidateId, undefined, (usage) => {
            if (budget) budget.spentUsd += usage.costUsd;
          }),
          timeoutMs,
          `negotiation between ${userId} and ${candidateId} timed out after ${timeoutMs}ms`
        );
      } catch (error) {
        if (error instanceof TimeoutError) {
          // Logged loudly (#307): a hung negotiation must never stall the
          // whole sweep. Treated as REJECTED-equivalent — both users simply
          // stay WAITING, exactly as a clean rejection would — rather than as
          // a NegotiationTurnFailure or an unexpected error, neither of which
          // fit "the call never came back" (see withTimeout — the abandoned
          // call's eventual outcome, if it ever resolves, is discarded).
          console.error(`orchestration: ${error.message}`);
          processedIds?.add(candidateId);
          continue;
        }
        throw error;
      }

      matchIds.push(match.id);
      await handleNegotiationOutcome(match);
      // Mark the candidate processed whether matched or rejected, so this
      // sweep neither renegotiates the same pair nor lets a just-rejected
      // candidate re-initiate against this user later in the same tick.
      processedIds?.add(candidateId);

      if (match.status === "MATCHED") {
        await completeMatchAttempt(attempt.id, "MATCHED", matchIds);
        return;
      }
    }
  } catch (error) {
    // A negotiation turn that threw NegotiationTurnFailure already exhausted
    // its own retries one layer down (agentSdkClient) — record the partial
    // transcript + error (#339) and fall through to the best-available fallback
    // below, exactly as a clean EXHAUSTED would, so a failed turn neither
    // discards paid spend nor denies the user their guaranteed match. Any other
    // error (DB, programmer bug) is unexpected and carries no partial
    // transcript of its own — it may throw before any negotiation or between
    // candidates after earlier negotiations completed (those stay on matchIds)
    // — record it as FAILED
    // with just the error message and reason "unexpected_error" (#378) so the
    // #253 audit page can tell a genuine crash apart from a clean EXHAUSTED
    // (nobody matched) instead of the two looking identical, then rethrow for
    // the caller's own handling.
    if (!(error instanceof NegotiationTurnFailure)) {
      await completeMatchAttempt(attempt.id, "FAILED", matchIds, {
        log: [],
        error: error instanceof Error ? error.message : String(error),
        reason: "unexpected_error",
      });
      throw error;
    }
    failure = { log: error.deliberationLog, error: error.message, reason: "negotiation_turn" };
  }

  // Guaranteed result (#chat-flow #8): pair the seeker with the best-available
  // person instead of leaving them stuck at "no match" — but only for callers
  // that actually asked for the guarantee (the manual find-match button and
  // onboarding's first cycle, both `guaranteeMatch=true`), or when a
  // negotiation turn itself failed to complete (`failure` set, #339) so paid
  // spend isn't silently wasted on an infra failure. A passive sweep tick
  // (`guaranteeMatch=false`) whose negotiations all ran cleanly and were
  // simply rejected leaves the user WAITING (EXHAUSTED) for a later cycle
  // instead of force-pairing them as the accidental steady state (#376) — real
  // negotiated matches are the goal, with this fallback as a safety net, not
  // the default outcome. This ignores hard criteria on purpose when it does
  // run — the whole point is that a guaranteed cycle never dead-ends. The
  // first pass excludes every candidate already tried (and rejected) via
  // negotiateAndPersist above in this same call, and — via
  // respectRejectionWindow's default of true (#374) — every candidate rejected
  // in an earlier cycle within the #344 window too, so a guaranteed cycle still
  // prefers a fresh candidate over one the agents turned down.
  //
  // The attempt is completed here — after the fallback runs, not before — so a
  // forced match is recorded on the attempt as FORCED instead of leaving it
  // EXHAUSTED while a Match row exists for it elsewhere (#315). Wrapped in
  // try/catch like the negotiation loop above: a throw partway through must
  // still close the attempt rather than leave it stuck at RUNNING forever. A
  // forced Match is pushed onto matchIds the instant it's persisted, so
  // matchIds growing past the already-negotiated set is what distinguishes a
  // genuine FORCED close from a false EXHAUSTED — even if handleNegotiationOutcome
  // throws right afterward.
  const negotiatedCount = matchIds.length;
  try {
    // Two independent gates on the fallback, both of which must let it through.
    //
    // The budget circuit breaker (#307): once the cap is hit, no further
    // Anthropic spend happens this sweep/cycle, including the (cheap, but
    // non-zero) fallback rationale call. The user simply stays WAITING for the
    // next tick, same as if the shortlist had genuinely been exhausted. Checked
    // first so a blown budget skips the countExhaustedAttempts query below,
    // whose only purpose is deciding whether to spend.
    //
    // The grace period (#301): a guaranteed cycle only earns the "always return
    // a match" fallback once this user has racked up enough prior EXHAUSTED
    // cycles. A negotiation-turn failure (`failure` set, #339) is a technical
    // fallback, not the guarantee, so it always runs regardless of grace —
    // paid spend on a failed turn shouldn't be wasted on top of a wait. The
    // budget gate still applies to it: #307's contract is that a tripped cap
    // stops all spend this tick, failure path included.
    const graceThreshold = forceMatchAfterSweeps();
    const guaranteeCleared =
      !budgetExhausted() &&
      guaranteeMatch &&
      (graceThreshold === 0 || (await countExhaustedAttempts(userId)) >= graceThreshold);

    if ((guaranteeCleared || failure) && !budgetExhausted()) {
      const paired = await forceBestAvailable(
        userId,
        new Set(candidateIds),
        matchIds,
        processedIds
      );

      // Manual-trigger / onboarding contract (#361, #376): a guaranteed cycle
      // must end in a match, period. Nobody outside the just-tried shortlist is
      // available, so the shortlist's rejected candidates become fair game —
      // force-pair with the best of them rather than coming up empty. Only a
      // genuinely empty pool (no other WAITING user at all) can still end
      // without a match. A negotiation-turn-failure fallback (guaranteeMatch
      // false, failure set) does NOT re-admit rejected candidates — that
      // stronger guarantee is reserved for callers that explicitly asked for it.
      // This is also the one deliberate, documented override of the #344
      // rejection window (#374) — respectRejectionWindow=false re-admits
      // candidates the automatic pass above just excluded, as the explicit
      // final resort. Gated on `guaranteeCleared` for a grace-cleared
      // guaranteed cycle, OR on `guaranteeMatch && failure` so a
      // negotiation-turn failure (#339, ADR-0027) keeps its full guarantee —
      // including this last-resort pass — regardless of the grace period,
      // exactly like the pre-#301 `guaranteeMatch`-only gate did.
      if (!paired && (guaranteeCleared || (guaranteeMatch && failure))) {
        await forceBestAvailable(userId, new Set(), matchIds, processedIds, false);
      }
    }

    if (failure) {
      await completeMatchAttempt(attempt.id, "FAILED", matchIds, failure, stoppedReason);
    } else {
      const status = matchIds.length > negotiatedCount ? "FORCED" : "EXHAUSTED";
      await completeMatchAttempt(attempt.id, status, matchIds, undefined, stoppedReason);
    }
  } catch (error) {
    if (failure) {
      await completeMatchAttempt(attempt.id, "FAILED", matchIds, failure, stoppedReason);
    } else {
      const status = matchIds.length > negotiatedCount ? "FORCED" : "EXHAUSTED";
      await completeMatchAttempt(attempt.id, status, matchIds, undefined, stoppedReason);
    }
    throw error;
  }
}

// Force-pairs the seeker with the best-available candidate, skipping (and
// re-ranking without) anyone who stopped WAITING since the ranking ran, instead
// of giving up on the first stale pick. Pushes the forced Match onto `matchIds`
// and returns it once persisted, or null when the pool (minus exclusions) is
// empty.
//
// respectRejectionWindow (#374) is forwarded to bestAvailableCandidateId so the
// automatic first pass below can't force-pair a couple the agents just
// rejected within the #344 window; the manual guaranteeMatch last-resort pass
// deliberately sets it false at its call site.
async function forceBestAvailable(
  userId: string,
  excludeIds: ReadonlySet<string>,
  matchIds: string[],
  processedIds?: Set<string>,
  respectRejectionWindow = true
): Promise<Match | null> {
  const excluded = new Set(excludeIds);
  // Neither exclusion set can change mid-call, so query both once up front
  // rather than re-querying them on every stale-candidate retry below.
  const recentlyRejectedIds = respectRejectionWindow
    ? await recentlyRejectedCandidateIds(userId)
    : undefined;
  const previouslyMatchedIds = await previouslyMatchedCandidateIds(userId);
  for (;;) {
    const fallbackId = await bestAvailableCandidateId(userId, excluded, {
      respectRejectionWindow,
      recentlyRejectedIds,
      previouslyMatchedIds,
    });
    if (!fallbackId) return null;
    const fallbackUser = await prisma.user.findUnique({ where: { id: fallbackId } });
    if (!fallbackUser || fallbackUser.matchingState !== "WAITING") {
      excluded.add(fallbackId);
      continue;
    }
    const forced = await forceMatchAndPersist(userId, fallbackId);
    matchIds.push(forced.id);
    await handleNegotiationOutcome(forced);
    processedIds?.add(fallbackId);
    return forced;
  }
}

// Applies a resolved negotiation's outcome (docs/adr/0011): MATCHED moves both
// users to MATCHED and notifies them; REJECTED leaves both in WAITING so
// they're picked up again on the next sweep.
async function handleNegotiationOutcome(match: Match): Promise<void> {
  // A freshly negotiated match cannot have a tombstone side, but this is the
  // shared outcome path — filtering here costs nothing and keeps the invariant
  // in one shape across every "both participants" write (docs/adr/0040).
  const userIds = [match.userAId, match.userBId].filter((id) => id !== DELETED_USER_ID);
  const nextState = match.status === "MATCHED" ? "MATCHED" : "WAITING";
  // enteredWaitingAt is reset on a re-entry to WAITING so the sweep's fairness
  // ordering below reflects this rejection, not the account's original
  // createdAt (#343).
  const data =
    nextState === "WAITING"
      ? { matchingState: nextState, enteredWaitingAt: new Date() }
      : { matchingState: nextState };

  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data,
  });

  if (match.status === "MATCHED") {
    // The sweep only negotiates WAITING users, so `from` is deterministic
    // here. A REJECTED negotiation leaves both users WAITING — no state
    // transition, so no MATCHING_STATE_CHANGED event (#552).
    for (const userId of userIds) {
      await recordEvent(
        "MATCHING_STATE_CHANGED",
        { from: "WAITING", to: "MATCHED", trigger: "negotiation_matched", matchId: match.id },
        { userId }
      );
    }
    await Promise.all(
      userIds.map((userId) =>
        notificationService.send(userId, "MATCH_FOUND", { matchId: match.id })
      )
    );
  }
}

// Shared mutual exclusion between the interval sweep (runOrchestrationTick)
// and the immediate first-cycle trigger (triggerFirstMatchCycle). Without
// this, a Phase-2-completion trigger can race a concurrent tick and both
// negotiate the same user/pair, producing duplicate Match rows and wasted
// Anthropic API calls. If the lock is held, the caller simply skips — a
// skipped trigger just falls back to being picked up on the next tick since
// the user is still WAITING.
//
// SINGLE-PROCESS ASSUMPTION (#342): `isRunning` is module-level in-memory
// state, so this only serializes work *within one Node process*. If the API
// ever runs as more than one instance (multiple replicas, or a separate
// worker), two processes can hold the lock simultaneously and sweep/negotiate
// the same users concurrently — reintroducing the duplicate-Match / wasted-
// spend race this lock exists to prevent. The POC runs a single API process,
// so this holds today. Going multi-instance requires replacing this with a
// cross-process lock (e.g. a SQLite lock row claimed transactionally) before
// scaling out.
//
// Returns true if `fn` ran, false if the lock was already held and the call
// was skipped — callers use this to log an otherwise-silent skip.
async function withOrchestrationLock(fn: () => Promise<void>): Promise<boolean> {
  if (isRunning) return false;
  isRunning = true;
  try {
    await fn();
  } finally {
    isRunning = false;
  }
  return true;
}

// Kicks off the first matching cycle for a user who just entered WAITING
// (Phase 2 just completed) rather than waiting for the next interval tick.
// The caller (barney.service) is fire-and-forget and handles its own error
// logging, so failures here are simply allowed to propagate.
// guaranteeMatch=true (#376): onboarding is one of the two callers the
// "never dead-end" guarantee (#chat-flow #8) is meant for — unlike the
// passive sweep, a fresh user's first cycle must still end in a match
// whenever anyone else is WAITING.
export async function triggerFirstMatchCycle(userId: string): Promise<void> {
  const budget: SweepBudget = { spentUsd: 0 };
  const ran = await withOrchestrationLock(() => matchOneUser(userId, undefined, true, budget));
  if (!ran) {
    // The immediate cycle was skipped because a sweep (or another trigger) held
    // the lock. Not lost: the user stays WAITING and is picked up on the next
    // tick. Logged so the "immediate match after onboarding" delay is visible
    // instead of vanishing silently (#342).
    console.warn(
      `orchestration: first-cycle trigger for ${userId} skipped — lock held; user stays WAITING for the next tick`
    );
  }
}

// True while a match cycle or sweep holds the orchestration lock — exposed so
// the Waiting page can show honest progress while Barney negotiates (#361).
export function isOrchestrationRunning(): boolean {
  return isRunning;
}

// Manual find-match trigger (#185, reworked in #361): kicks the cycle off in
// the BACKGROUND and reports immediately whether it started. The old shape ran
// the full cycle synchronously — up to 5 real negotiations, minutes of
// wall-clock — so the HTTP request timed out while the work kept going, and a
// press during a running cycle silently no-opped but reported "no match".
// The caller polls /state (and isOrchestrationRunning via its route) for the
// outcome; started:false means a cycle was already in flight — equally good
// news for the presser, someone is already searching for everyone WAITING.
// guaranteeMatch=true: unlike the automatic sweeps, a manual press must end in
// a match whenever anyone else is WAITING — even a candidate the negotiation
// just rejected, as the last resort.
export function startMatchCycle(userId: string): { started: boolean } {
  if (isRunning) return { started: false };
  const budget: SweepBudget = { spentUsd: 0 };
  // withOrchestrationLock sets isRunning synchronously before its first await,
  // so back-to-back callers in the same tick can't both start.
  void withOrchestrationLock(() => matchOneUser(userId, undefined, true, budget)).catch((error) => {
    console.error(`orchestration: manual match cycle for ${userId} failed:`, error);
  });
  return { started: true };
}

// One Match Day sweep (docs/adr/0011): every WAITING user gets their top
// deterministic-filter candidate negotiated. Skips entirely if the previous
// sweep (or a first-cycle trigger) is still running rather than overlapping
// with it. `processedIds` tracks every user already negotiated this sweep —
// as either the initiator or the candidate — so a rejected pair (both users
// stay WAITING) isn't renegotiated a second time when the loop later reaches
// the other member of the pair. A failure for one user is logged and does
// not stop the rest of the sweep.
export async function runOrchestrationTick(): Promise<void> {
  await withOrchestrationLock(async () => {
    // Sweep longest-waiting user first (#343). Raw findMany order is DB row /
    // insertion order, which quietly advantages earlier registrations every
    // tick: an early user's force-match fallback can consume the scarce
    // best-available person before later users are even considered. Ordering by
    // enteredWaitingAt ascending makes the sweep fair and deterministic —
    // whoever has waited longest gets first pick. Unlike createdAt (account
    // creation time), enteredWaitingAt is reset every time a user re-enters
    // WAITING (persistWantedProfile.ts, decision.service.ts,
    // handleNegotiationOutcome above, followup.service.ts), so it stays
    // accurate for the common case of repeat daters cycling back through
    // WAITING, not just first-time registrants.
    // Per-user shortlist ranking (ADR-0023) is unaffected.
    const waitingUsers = await prisma.user.findMany({
      // A deleted account must never be swept as a seeker, whatever its
      // matchingState column happens to say (docs/adr/0040).
      where: { matchingState: "WAITING", id: { not: DELETED_USER_ID } },
      // Secondary sort by id keeps the sweep fully deterministic when two users
      // share the same enteredWaitingAt millisecond (e.g. a freshly seeded cohort).
      orderBy: [{ enteredWaitingAt: "asc" }, { id: "asc" }],
    });
    const processedIds = new Set<string>();
    // Shared across every user in this sweep (#307) — SWEEP_BUDGET_USD caps
    // real Anthropic spend for the whole tick, not per-user.
    const budget: SweepBudget = { spentUsd: 0 };

    for (const user of waitingUsers) {
      if (processedIds.has(user.id)) continue;
      try {
        await matchOneUser(user.id, processedIds, false, budget);
      } catch (error) {
        console.error(`orchestration: failed to process user ${user.id}:`, error);
      }
    }
  });
}

export function startOrchestrationLoop(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runOrchestrationTick();
  }, cooldownMs());
}

export function stopOrchestrationLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
