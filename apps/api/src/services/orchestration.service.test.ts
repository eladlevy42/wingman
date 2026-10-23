import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Match } from "@wingman/database";
import type { CandidateScore } from "@wingman/shared";

vi.mock("@wingman/database", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  // The tombstone id the guards under test exclude by identity (docs/adr/0040).
  DELETED_USER_ID: "00000000-0000-4000-8000-000000000000",
}));

vi.mock("./matching.service", () => ({
  scoreCandidates: vi.fn(),
  bestAvailableCandidateId: vi.fn(),
  recentlyRejectedCandidateIds: vi.fn(),
  previouslyMatchedCandidateIds: vi.fn(),
}));

vi.mock("./negotiation.service", () => ({
  negotiateAndPersist: vi.fn(),
  forceMatchAndPersist: vi.fn(),
}));

vi.mock("./user.service", () => ({
  getUserState: vi.fn(),
}));

vi.mock("./notification.service", () => ({
  notificationService: { send: vi.fn() },
}));

vi.mock("./matchAttempt.service", () => ({
  createMatchAttempt: vi.fn(),
  completeMatchAttempt: vi.fn(),
  countExhaustedAttempts: vi.fn(),
}));

vi.mock("./audit.service", () => ({ recordEvent: vi.fn() }));

import { prisma, DELETED_USER_ID } from "@wingman/database";
import { recordEvent } from "./audit.service";
import { scoreCandidates, bestAvailableCandidateId } from "./matching.service";
import { negotiateAndPersist, forceMatchAndPersist } from "./negotiation.service";
import { NegotiationTurnFailure } from "../agents/negotiation.agent";
import { notificationService } from "./notification.service";
import {
  createMatchAttempt,
  completeMatchAttempt,
  countExhaustedAttempts,
} from "./matchAttempt.service";
import {
  runOrchestrationTick,
  triggerFirstMatchCycle,
  startMatchCycle,
  isOrchestrationRunning,
  startOrchestrationLoop,
  stopOrchestrationLoop,
  cooldownMs,
  decisionWindowMs,
  forceMatchAfterSweeps,
  negotiationTimeoutMs,
  sweepBudgetUsd,
} from "./orchestration.service";

function waitingUser(id: string) {
  return { id, matchingState: "WAITING" };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: "match-1",
    userAId: "user-a",
    userBId: "user-b",
    status: "MATCHED",
    scoreA: 8,
    scoreB: 8,
    deliberationLog: "[]",
    rationale: "Great match.",
    createdAt: new Date(),
    ...overrides,
  } as Match;
}

// Builds the CandidateScore[] scoreCandidates would return for a shortlist of
// candidate ids, in shortlist order — mirrors what deterministicFilter used
// to hand back directly before #253 split it into a diagnostic pool.
function scored(candidateIds: string[]): CandidateScore[] {
  return candidateIds.map((candidateId, rank) => ({
    candidateId,
    passedHardCriteria: true,
    failureReason: null,
    overlapScore: candidateIds.length - rank,
    rank,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCH_COOLDOWN_MINUTES = "1";
  delete process.env.DECISION_WINDOW_MINUTES;
  // Default: grace period disabled (#301's escape hatch), so every existing
  // guaranteed-cycle test keeps exercising "force fires on the first cycle" —
  // the behavior that predates this issue. Tests for the grace period itself
  // set a non-zero threshold explicitly.
  process.env.FORCE_MATCH_AFTER_SWEEPS = "0";
  delete process.env.NEGOTIATION_TIMEOUT_MS;
  delete process.env.SWEEP_BUDGET_USD;
  vi.mocked(createMatchAttempt).mockResolvedValue({ id: "attempt-1" } as never);
  vi.mocked(countExhaustedAttempts).mockResolvedValue(0);
  // Default: no best-available fallback, so tests that only exercise the normal
  // negotiate-or-reject path keep their original meaning (a rejection leaves both
  // users WAITING). Tests for the guaranteed-match fallback (#chat-flow #8)
  // override this with a concrete id.
  vi.mocked(bestAvailableCandidateId).mockResolvedValue(null);
});

afterEach(() => {
  stopOrchestrationLoop();
  vi.useRealTimers();
});

describe("runOrchestrationTick", () => {
  it("negotiates each waiting user's top candidate and updates matchingState on match", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "MATCHED" }));

    await runOrchestrationTick();

    expect(negotiateAndPersist).toHaveBeenCalledWith(
      "user-a",
      "user-b",
      undefined,
      expect.any(Function)
    );
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-a", "user-b"] } },
      data: { matchingState: "MATCHED" },
    });
    expect(notificationService.send).toHaveBeenCalledWith("user-a", "MATCH_FOUND", {
      matchId: "match-1",
    });
    expect(notificationService.send).toHaveBeenCalledWith("user-b", "MATCH_FOUND", {
      matchId: "match-1",
    });
  });

  it("puts both users back to WAITING when the negotiation is rejected", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "REJECTED" }));

    await runOrchestrationTick();

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-a", "user-b"] } },
      data: { matchingState: "WAITING", enteredWaitingAt: expect.any(Date) },
    });
    expect(notificationService.send).not.toHaveBeenCalled();
  });

  // #552: a successful negotiation is a WAITING -> MATCHED transition for both
  // users; a rejected one leaves both WAITING — no transition, no event.
  it("records a MATCHING_STATE_CHANGED audit event per user on match, and none on rejection", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "MATCHED" }));

    await runOrchestrationTick();

    for (const userId of ["user-a", "user-b"]) {
      expect(recordEvent).toHaveBeenCalledWith(
        "MATCHING_STATE_CHANGED",
        { from: "WAITING", to: "MATCHED", trigger: "negotiation_matched", matchId: "match-1" },
        { userId }
      );
    }

    vi.mocked(recordEvent).mockClear();
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "REJECTED" }));

    await runOrchestrationTick();

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("skips negotiating when there is no eligible candidate this tick", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue([]);

    await runOrchestrationTick();

    expect(negotiateAndPersist).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("skips a user already paired earlier in the same tick", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-b")] as never);
    // Snapshot said WAITING, but by the time we get to it, it's already MATCHED.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-b",
      matchingState: "MATCHED",
    } as never);

    await runOrchestrationTick();

    expect(scoreCandidates).not.toHaveBeenCalled();
    expect(negotiateAndPersist).not.toHaveBeenCalled();
  });

  it("does not renegotiate a rejected pair later in the same sweep", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      waitingUser("user-a"),
      waitingUser("user-b"),
    ] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "REJECTED" }));

    await runOrchestrationTick();

    expect(negotiateAndPersist).toHaveBeenCalledTimes(1);
    // Two lookups: user-a's own WAITING check, then a re-check of candidate
    // user-b right before negotiating. user-b is skipped as an initiator
    // afterwards (added to processedIds), so the pair is never renegotiated.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it("walks the shortlist and matches a later candidate when an earlier one is rejected", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    // scoreCandidates hands back the top-3 most-alike candidates.
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b", "user-c", "user-d"]));
    vi.mocked(negotiateAndPersist)
      .mockResolvedValueOnce(makeMatch({ status: "REJECTED", userBId: "user-b" }))
      .mockResolvedValueOnce(makeMatch({ status: "MATCHED", userBId: "user-c" }));

    await runOrchestrationTick();

    // Negotiated user-b (rejected), then user-c (matched), then stopped —
    // user-d is never negotiated once a match lands.
    expect(negotiateAndPersist).toHaveBeenCalledTimes(2);
    expect(negotiateAndPersist).toHaveBeenNthCalledWith(
      1,
      "user-a",
      "user-b",
      undefined,
      expect.any(Function)
    );
    expect(negotiateAndPersist).toHaveBeenNthCalledWith(
      2,
      "user-a",
      "user-c",
      undefined,
      expect.any(Function)
    );
    expect(negotiateAndPersist).not.toHaveBeenCalledWith(
      "user-a",
      "user-d",
      undefined,
      expect.any(Function)
    );
  });

  it("logs and continues past a failure for one user", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      waitingUser("user-a"),
      waitingUser("user-c"),
    ] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates)
      .mockResolvedValueOnce(scored(["user-b"]))
      .mockResolvedValueOnce(scored(["user-d"]));
    vi.mocked(negotiateAndPersist)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(makeMatch());

    await runOrchestrationTick();

    expect(consoleError).toHaveBeenCalled();
    expect(negotiateAndPersist).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  // #376: the passive sweep must not force-match at all — the guaranteed-match
  // fallback (best-available) is reserved for callers that explicitly ask for
  // it (the manual find-match button, onboarding's first cycle), not every
  // automatic tick. A rejected negotiation simply leaves the user WAITING.
  it("never force-pairs a just-rejected candidate — the passive sweep doesn't run the fallback at all", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "REJECTED" }));
    // Same setup where startMatchCycle would force-pair user-b as a last
    // resort — the automatic sweep instead leaves the user WAITING for a
    // later cycle, never even consulting the fallback.
    vi.mocked(bestAvailableCandidateId).mockImplementation(async (_userId, excludeIds) =>
      excludeIds?.has("user-b") ? null : "user-b"
    );

    await runOrchestrationTick();

    expect(forceMatchAndPersist).not.toHaveBeenCalled();
    expect(bestAvailableCandidateId).not.toHaveBeenCalled();
  });

  // #343: the sweep must ask the DB for WAITING users longest-waiting first
  // (enteredWaitingAt ascending) rather than raw row order, so earlier
  // registrations don't perpetually get first pick of the pool every tick.
  it("fetches waiting users ordered by enteredWaitingAt ascending (longest-waiting first)", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);

    await runOrchestrationTick();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      // The deleted-user tombstone never enters the sweep, whatever its
      // matchingState column says (docs/adr/0040).
      where: { matchingState: "WAITING", id: { not: DELETED_USER_ID } },
      orderBy: [{ enteredWaitingAt: "asc" }, { id: "asc" }],
    });
  });

  // #343: given users with differing wait times, the one who has waited longest
  // is negotiated first. The DB returns them in enteredWaitingAt-ascending
  // order, and the sweep processes them in exactly that order.
  it("processes the longest-waiting user first given differing wait times", async () => {
    // Returned in the order the ordered query would yield: oldest enteredWaitingAt first.
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      waitingUser("user-old"),
      waitingUser("user-new"),
    ] as never);
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { where: { id: string } }) =>
      waitingUser(args.where.id)) as never);
    // Each seeker matches a distinct partner so neither is skipped as already
    // processed, letting us observe the initiator order directly.
    vi.mocked(scoreCandidates).mockImplementation(async (userId: string) =>
      scored([userId === "user-old" ? "user-p" : "user-q"])
    );
    vi.mocked(negotiateAndPersist).mockImplementation(async (aId: string, bId: string) =>
      makeMatch({ status: "MATCHED", userAId: aId, userBId: bId })
    );

    await runOrchestrationTick();

    expect(negotiateAndPersist).toHaveBeenNthCalledWith(
      1,
      "user-old",
      "user-p",
      undefined,
      expect.any(Function)
    );
    expect(negotiateAndPersist).toHaveBeenNthCalledWith(
      2,
      "user-new",
      "user-q",
      undefined,
      expect.any(Function)
    );
  });

  it("skips the whole sweep if the previous one is still running", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));

    let resolveNegotiation!: (match: Match) => void;
    vi.mocked(negotiateAndPersist).mockReturnValue(
      new Promise((resolve) => {
        resolveNegotiation = resolve;
      })
    );

    const firstTick = runOrchestrationTick();
    const secondTick = runOrchestrationTick();

    resolveNegotiation(makeMatch());
    await Promise.all([firstTick, secondTick]);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  // #376: the core regression this issue fixes — two WAITING users who are
  // mutually incompatible (empty shortlist each) must be able to end a
  // passive sweep tick still WAITING, not force-paired with each other as a
  // last resort. Before the fix, forceBestAvailable ran unconditionally and
  // nearly always found a "best available" pairing regardless of fit.
  it("ends with both mutually-incompatible WAITING users still WAITING (EXHAUSTED), not force-matched", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      waitingUser("user-a"),
      waitingUser("user-b"),
    ] as never);
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { where: { id: string } }) =>
      waitingUser(args.where.id)) as never);
    // Neither user's deterministic filter finds the other eligible.
    vi.mocked(scoreCandidates).mockResolvedValue([]);

    await runOrchestrationTick();

    expect(negotiateAndPersist).not.toHaveBeenCalled();
    expect(bestAvailableCandidateId).not.toHaveBeenCalled();
    expect(forceMatchAndPersist).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(completeMatchAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "EXHAUSTED",
      [],
      undefined,
      undefined
    );
  });
});

describe("MatchAttempt persistence", () => {
  it("still creates and completes an EXHAUSTED attempt when there are zero eligible candidates", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue([]);

    await runOrchestrationTick();

    expect(createMatchAttempt).toHaveBeenCalledWith("user-a", []);
    expect(completeMatchAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "EXHAUSTED",
      [],
      undefined,
      undefined
    );
  });

  it("creates a RUNNING attempt with the full candidate pool, then completes it MATCHED", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    const pool = scored(["user-b", "user-c"]);
    vi.mocked(scoreCandidates).mockResolvedValue(pool);
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "MATCHED" }));

    await runOrchestrationTick();

    expect(createMatchAttempt).toHaveBeenCalledWith("user-a", pool);
    expect(completeMatchAttempt).toHaveBeenCalledWith("attempt-1", "MATCHED", ["match-1"]);
  });

  it("completes an attempt EXHAUSTED when every shortlisted candidate is rejected", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b", "user-c"]));
    vi.mocked(negotiateAndPersist)
      .mockResolvedValueOnce(makeMatch({ id: "match-1", status: "REJECTED" }))
      .mockResolvedValueOnce(makeMatch({ id: "match-2", status: "REJECTED" }));

    await runOrchestrationTick();

    expect(completeMatchAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "EXHAUSTED",
      ["match-1", "match-2"],
      undefined,
      undefined
    );
  });

  // #378: an unexpected error (DB failure, programmer bug) is not a genuine
  // exhaustion — recording it as EXHAUSTED hid real failures from the #253
  // audit page, indistinguishable from "walked the shortlist, nobody
  // matched". It's now recorded FAILED with the error message instead.
  it("completes the attempt FAILED, not EXHAUSTED, when an unexpected error throws mid-loop", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runOrchestrationTick();

    expect(completeMatchAttempt).toHaveBeenCalledWith("attempt-1", "FAILED", [], {
      log: [],
      error: "boom",
      reason: "unexpected_error",
    });
    // Unlike a NegotiationTurnFailure, an unexpected error never reaches the
    // best-available fallback — it's rethrown for the sweep's own per-user
    // catch to log, not silently recovered from.
    expect(bestAvailableCandidateId).not.toHaveBeenCalled();
  });

  // #378: when an unexpected error throws AFTER earlier candidates were already
  // negotiated (and rejected), the match ids accumulated so far must be carried
  // onto the FAILED record — dropping them would orphan the Match rows those
  // paid negotiations produced from the attempt on the audit page.
  it("preserves the accumulated matchIds on the FAILED record when an unexpected error throws after an earlier negotiation", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b", "user-c"]));
    // First candidate negotiates and is rejected (accumulating match-1), then
    // the second candidate throws an unexpected error.
    vi.mocked(negotiateAndPersist)
      .mockResolvedValueOnce(makeMatch({ id: "match-1", status: "REJECTED", userBId: "user-b" }))
      .mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runOrchestrationTick();

    expect(completeMatchAttempt).toHaveBeenCalledWith("attempt-1", "FAILED", ["match-1"], {
      log: [],
      error: "boom",
      reason: "unexpected_error",
    });
    expect(bestAvailableCandidateId).not.toHaveBeenCalled();
  });

  // Issue #339: a negotiation turn failure (already retried and exhausted one
  // layer down, in agentSdkClient) persists the partial transcript instead of
  // being discarded, and — unlike an unexpected error — falls through to the
  // guaranteed-match fallback just like a clean EXHAUSTED would.
  it("completes the attempt FAILED and persists the partial log when a negotiation turn throws", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    const partialLog = [{ speaker: "Alex's agent", content: "hi" }];
    vi.mocked(negotiateAndPersist).mockRejectedValue(
      new NegotiationTurnFailure(
        "runNegotiation: a turn failed — boom",
        partialLog,
        0.01,
        500,
        new Error("boom")
      )
    );

    await runOrchestrationTick();

    expect(completeMatchAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "FAILED",
      [],
      {
        log: partialLog,
        error: "runNegotiation: a turn failed — boom",
        reason: "negotiation_turn",
      },
      undefined
    );
    expect(bestAvailableCandidateId).toHaveBeenCalled();
  });

  // #315: the best-available fallback used to run after the attempt was
  // already closed out as EXHAUSTED, so the forced Match was never linked to
  // it and the audit page showed "exhausted, no match" for a user who was
  // actually MATCHED. The attempt must reflect the forced pairing instead.
  // Exercised via startMatchCycle (guaranteeMatch=true) rather than the
  // passive sweep — since #376, the fallback only runs for a guaranteed cycle.
  it("completes the attempt FORCED, with the forced match id appended, when the best-available fallback fires", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(
      makeMatch({ id: "match-1", status: "REJECTED" })
    );
    vi.mocked(bestAvailableCandidateId).mockResolvedValue("user-z");
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ id: "match-forced", status: "MATCHED", userAId: "user-a", userBId: "user-z" })
    );

    startMatchCycle("user-a");

    await vi.waitFor(() => {
      expect(completeMatchAttempt).toHaveBeenCalledWith(
        "attempt-1",
        "FORCED",
        ["match-1", "match-forced"],
        undefined,
        undefined
      );
    });
  });

  // #350: the fallback block ran outside any try/catch, so a throw here left
  // the attempt stuck at RUNNING forever instead of being closed out — the
  // same failure mode the negotiation loop's catch above already guards
  // against. Exercised via startMatchCycle since #376 gated the fallback
  // behind guaranteeMatch.
  it("still completes the attempt EXHAUSTED when the best-available lookup throws", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(
      makeMatch({ id: "match-1", status: "REJECTED" })
    );
    vi.mocked(bestAvailableCandidateId).mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startMatchCycle("user-a");

    await vi.waitFor(() => {
      expect(completeMatchAttempt).toHaveBeenCalledWith(
        "attempt-1",
        "EXHAUSTED",
        ["match-1"],
        undefined,
        undefined
      );
    });
    errorSpy.mockRestore();
  });

  it("completes the attempt FORCED, not EXHAUSTED, when the forced match persists but handling its outcome throws", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(
      makeMatch({ id: "match-1", status: "REJECTED" })
    );
    vi.mocked(bestAvailableCandidateId).mockResolvedValue("user-z");
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ id: "match-forced", status: "MATCHED", userAId: "user-a", userBId: "user-z" })
    );
    vi.mocked(notificationService.send).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startMatchCycle("user-a");

    await vi.waitFor(() => {
      expect(completeMatchAttempt).toHaveBeenCalledWith(
        "attempt-1",
        "FORCED",
        ["match-1", "match-forced"],
        undefined,
        undefined
      );
    });
    errorSpy.mockRestore();
  });
});

describe("triggerFirstMatchCycle", () => {
  it("negotiates immediately for the given user without waiting for a tick", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "MATCHED" }));

    await triggerFirstMatchCycle("user-a");

    expect(negotiateAndPersist).toHaveBeenCalledWith(
      "user-a",
      "user-b",
      undefined,
      expect.any(Function)
    );
  });

  it("propagates a failure to the caller instead of swallowing it", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockRejectedValue(new Error("boom"));

    await expect(triggerFirstMatchCycle("user-a")).rejects.toThrow("boom");
  });

  // #376: onboarding's first cycle is one of the two callers the "never
  // dead-end" guarantee (#chat-flow #8) is meant for, so it must still force a
  // match via the best-available fallback when the shortlist rejects — unlike
  // the passive sweep, which leaves the guarantee off.
  it("guarantees a match via the best-available fallback when nobody clears the threshold, unlike the passive sweep", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "REJECTED" }));
    vi.mocked(bestAvailableCandidateId).mockResolvedValue("user-z");
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ status: "MATCHED", userAId: "user-a", userBId: "user-z" })
    );

    await triggerFirstMatchCycle("user-a");

    expect(forceMatchAndPersist).toHaveBeenCalledWith("user-a", "user-z");
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-a", "user-z"] } },
      data: { matchingState: "MATCHED" },
    });
  });

  // Issue #339: a NegotiationTurnFailure is a well-understood, already-persisted
  // outcome (see the FAILED MatchAttempt), not an unexpected error — it does not
  // propagate the way a genuine bug or DB failure still does above.
  it("does not propagate a NegotiationTurnFailure — it's recorded on the attempt instead", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockRejectedValue(
      new NegotiationTurnFailure(
        "runNegotiation: a turn failed — boom",
        [],
        0,
        0,
        new Error("boom")
      )
    );

    await expect(triggerFirstMatchCycle("user-a")).resolves.toBeUndefined();
  });

  it("skips instead of racing a sweep that is already in progress", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));

    let resolveNegotiation!: (match: Match) => void;
    vi.mocked(negotiateAndPersist).mockReturnValue(
      new Promise((resolve) => {
        resolveNegotiation = resolve;
      })
    );

    const tick = runOrchestrationTick();
    await triggerFirstMatchCycle("user-c");

    resolveNegotiation(makeMatch());
    await tick;

    // Only the in-flight tick's negotiation happened — the racing trigger
    // for user-c was skipped rather than negotiating concurrently.
    expect(negotiateAndPersist).toHaveBeenCalledTimes(1);
    expect(negotiateAndPersist).toHaveBeenCalledWith(
      "user-a",
      "user-b",
      undefined,
      expect.any(Function)
    );
  });

  // #342: a lock-held skip used to be silent, so the "immediate match after
  // onboarding" delay vanished with no signal. It now logs.
  it("logs a warning when it skips because the lock is already held", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));

    let resolveNegotiation!: (match: Match) => void;
    vi.mocked(negotiateAndPersist).mockReturnValue(
      new Promise((resolve) => {
        resolveNegotiation = resolve;
      })
    );

    const tick = runOrchestrationTick();
    await triggerFirstMatchCycle("user-c");

    resolveNegotiation(makeMatch());
    await tick;

    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("user-c"));
    consoleWarn.mockRestore();
  });

  it("does not log a skip when it actually runs the cycle", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "MATCHED" }));

    await triggerFirstMatchCycle("user-a");

    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});

describe("startMatchCycle (#361)", () => {
  it("returns started:true immediately and runs the cycle in the background", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "MATCHED" }));

    const result = startMatchCycle("user-a");

    expect(result).toEqual({ started: true });
    // The negotiation happens after the synchronous return — in the background.
    await vi.waitFor(() => {
      expect(negotiateAndPersist).toHaveBeenCalledWith(
        "user-a",
        "user-b",
        undefined,
        expect.any(Function)
      );
    });
    await vi.waitFor(() => {
      expect(isOrchestrationRunning()).toBe(false);
    });
  });

  it("returns started:false while a cycle is already in flight, and never double-runs", async () => {
    let releaseNegotiation!: (m: Match) => void;
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockImplementation(
      () => new Promise((resolve) => (releaseNegotiation = resolve))
    );

    const first = startMatchCycle("user-a");
    // Wait until the background cycle has actually reached the negotiation —
    // the lock is held for its whole duration.
    await vi.waitFor(() => expect(negotiateAndPersist).toHaveBeenCalledTimes(1));
    const second = startMatchCycle("user-a");

    expect(first).toEqual({ started: true });
    expect(second).toEqual({ started: false });
    expect(isOrchestrationRunning()).toBe(true);

    releaseNegotiation(makeMatch({ status: "MATCHED" }));
    await vi.waitFor(() => expect(isOrchestrationRunning()).toBe(false));
    expect(negotiateAndPersist).toHaveBeenCalledTimes(1);
  });

  it("guarantees a match via the best-available fallback when nobody clears the threshold (#8)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    // A candidate exists but the negotiation rejects it; the fallback then pairs
    // the seeker with the best-available person so onboarding never dead-ends.
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "REJECTED" }));
    vi.mocked(bestAvailableCandidateId).mockResolvedValue("user-z");
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ status: "MATCHED", userAId: "user-a", userBId: "user-z" })
    );

    expect(startMatchCycle("user-a")).toEqual({ started: true });

    await vi.waitFor(() => {
      expect(forceMatchAndPersist).toHaveBeenCalledWith("user-a", "user-z");
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-a", "user-z"] } },
      data: { matchingState: "MATCHED" },
    });
    // Wait out the lock release so the module-level isRunning flag can't
    // bleed into the next test.
    await vi.waitFor(() => expect(isOrchestrationRunning()).toBe(false));
  });

  it("force-pairs a just-rejected candidate when nobody else is available (no-matter-what guarantee)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    // The only other waiting user IS the shortlist: negotiation rejects them,
    // and the first fallback pass (which excludes just-tried candidates) finds
    // nobody. A manual press must still end in a match, so the second pass
    // drops the exclusion and force-pairs the rejected candidate.
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "REJECTED" }));
    vi.mocked(bestAvailableCandidateId).mockImplementation(async (_userId, excludeIds) =>
      excludeIds?.has("user-b") ? null : "user-b"
    );
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ status: "MATCHED", userAId: "user-a", userBId: "user-b" })
    );

    expect(startMatchCycle("user-a")).toEqual({ started: true });

    await vi.waitFor(() => {
      expect(forceMatchAndPersist).toHaveBeenCalledWith("user-a", "user-b");
    });
    // #374: the first pass respects the #344 rejection window (default true);
    // only the documented last-resort second pass explicitly overrides it.
    // objectContaining keeps these assertions focused on the flag — the options
    // object also carries precomputed recentlyRejectedIds/previouslyMatchedIds
    // sets (undefined here since their queries are mocked without values).
    expect(bestAvailableCandidateId).toHaveBeenNthCalledWith(
      1,
      "user-a",
      new Set(["user-b"]),
      expect.objectContaining({ respectRejectionWindow: true })
    );
    expect(bestAvailableCandidateId).toHaveBeenNthCalledWith(
      2,
      "user-a",
      new Set(),
      expect.objectContaining({ respectRejectionWindow: false })
    );
    await vi.waitFor(() => expect(isOrchestrationRunning()).toBe(false));
  });

  it("retries the next-best fallback when the first pick stopped WAITING mid-cycle", async () => {
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
      where: { id: string };
    }) => {
      if (args.where.id === "user-z") return { id: "user-z", matchingState: "MATCHED" };
      return waitingUser(args.where.id);
    }) as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(makeMatch({ status: "REJECTED" }));
    // Best-available first proposes user-z (already paired off elsewhere), and
    // only once user-z is excluded proposes user-y — the old single-shot code
    // gave up at user-z and ended the press without a match.
    vi.mocked(bestAvailableCandidateId).mockImplementation(async (_userId, excludeIds) =>
      excludeIds?.has("user-z") ? "user-y" : "user-z"
    );
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ status: "MATCHED", userAId: "user-a", userBId: "user-y" })
    );

    expect(startMatchCycle("user-a")).toEqual({ started: true });

    await vi.waitFor(() => {
      expect(forceMatchAndPersist).toHaveBeenCalledWith("user-a", "user-y");
    });
    expect(forceMatchAndPersist).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(isOrchestrationRunning()).toBe(false));
  });

  it("logs a failed background cycle and releases the lock instead of rejecting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(startMatchCycle("user-a")).toEqual({ started: true });

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("user-a"), expect.anything());
    });
    expect(isOrchestrationRunning()).toBe(false);
    errorSpy.mockRestore();
  });
});

describe("negotiation timeout (#307)", () => {
  it("leaves both users WAITING instead of matching when a negotiation hangs past NEGOTIATION_TIMEOUT_MS", async () => {
    process.env.NEGOTIATION_TIMEOUT_MS = "10";
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    // Simulates a stuck Agent SDK subprocess — never resolves or rejects.
    vi.mocked(negotiateAndPersist).mockReturnValue(new Promise(() => {}));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runOrchestrationTick();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(completeMatchAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "EXHAUSTED",
      [],
      undefined,
      undefined
    );
    errorSpy.mockRestore();
  });

  it("continues to the next candidate after a hung negotiation times out, instead of stalling the sweep", async () => {
    process.env.NEGOTIATION_TIMEOUT_MS = "10";
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b", "user-c"]));
    vi.mocked(negotiateAndPersist)
      .mockReturnValueOnce(new Promise(() => {})) // user-b hangs
      .mockResolvedValueOnce(makeMatch({ id: "match-1", status: "REJECTED", userBId: "user-c" }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runOrchestrationTick();

    expect(negotiateAndPersist).toHaveBeenCalledTimes(2);
    // Only user-c's clean rejection reaches handleNegotiationOutcome — the
    // hung user-b call never does.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(completeMatchAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "EXHAUSTED",
      ["match-1"],
      undefined,
      undefined
    );
  });
});

describe("sweep budget cap (#307)", () => {
  it("stops walking a user's shortlist once SWEEP_BUDGET_USD is spent, and records why on the attempt", async () => {
    process.env.SWEEP_BUDGET_USD = "1";
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b", "user-c"]));
    vi.mocked(negotiateAndPersist).mockImplementation((async (
      _a: string,
      _b: string,
      _config: unknown,
      onUsage?: (u: unknown) => void
    ) => {
      onUsage?.({ costUsd: 1.5, durationMs: 1000 });
      return makeMatch({ id: "match-1", status: "REJECTED" });
    }) as never);

    await runOrchestrationTick();

    // The first candidate's cost alone ($1.50) already exceeds the $1 cap, so
    // the second candidate is never tried this tick.
    expect(negotiateAndPersist).toHaveBeenCalledTimes(1);
    expect(completeMatchAttempt).toHaveBeenCalledWith(
      "attempt-1",
      "EXHAUSTED",
      ["match-1"],
      undefined,
      "sweep_budget"
    );
  });

  it("shares the budget across every user in the same sweep tick", async () => {
    process.env.SWEEP_BUDGET_USD = "1";
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      waitingUser("user-a"),
      waitingUser("user-b"),
    ] as never);
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { where: { id: string } }) =>
      waitingUser(args.where.id)) as never);
    vi.mocked(scoreCandidates).mockImplementation(async (userId: string) =>
      scored([userId === "user-a" ? "user-x" : "user-y"])
    );
    vi.mocked(negotiateAndPersist).mockImplementation((async (
      _a: string,
      _b: string,
      _config: unknown,
      onUsage?: (u: unknown) => void
    ) => {
      onUsage?.({ costUsd: 2, durationMs: 1000 });
      return makeMatch({ id: "match-1", status: "REJECTED" });
    }) as never);

    await runOrchestrationTick();

    // user-a's single negotiation already blows the shared $1 budget, so
    // user-b's shortlist walk stops before ever calling negotiateAndPersist.
    expect(negotiateAndPersist).toHaveBeenCalledTimes(1);
    expect(negotiateAndPersist).toHaveBeenCalledWith(
      "user-a",
      "user-x",
      undefined,
      expect.any(Function)
    );
  });

  it("does not run the guarantee fallback once the budget is exhausted", async () => {
    process.env.SWEEP_BUDGET_USD = "1";
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b", "user-c"]));
    vi.mocked(negotiateAndPersist).mockImplementation((async (
      _a: string,
      _b: string,
      _config: unknown,
      onUsage?: (u: unknown) => void
    ) => {
      onUsage?.({ costUsd: 2, durationMs: 1000 });
      return makeMatch({ id: "match-1", status: "REJECTED" });
    }) as never);

    startMatchCycle("user-a");

    await vi.waitFor(() => {
      expect(completeMatchAttempt).toHaveBeenCalledWith(
        "attempt-1",
        "EXHAUSTED",
        ["match-1"],
        undefined,
        "sweep_budget"
      );
    });
    // guaranteeMatch=true would normally force-pair via the fallback — the
    // exhausted budget must suppress that too.
    expect(bestAvailableCandidateId).not.toHaveBeenCalled();
  });
});

describe("negotiationTimeoutMs / sweepBudgetUsd (#307)", () => {
  it("negotiationTimeoutMs defaults to 5 minutes when unset or blank, without warning", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    delete process.env.NEGOTIATION_TIMEOUT_MS;
    expect(negotiationTimeoutMs()).toBe(5 * 60 * 1000);

    process.env.NEGOTIATION_TIMEOUT_MS = "  ";
    expect(negotiationTimeoutMs()).toBe(5 * 60 * 1000);

    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("negotiationTimeoutMs uses an explicit override", () => {
    process.env.NEGOTIATION_TIMEOUT_MS = "30000";
    expect(negotiationTimeoutMs()).toBe(30000);
  });

  it("negotiationTimeoutMs warns and falls back to the default on invalid values", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const invalid of ["abc", "0", "-5"]) {
      process.env.NEGOTIATION_TIMEOUT_MS = invalid;
      expect(negotiationTimeoutMs()).toBe(5 * 60 * 1000);
    }

    expect(consoleWarn).toHaveBeenCalledTimes(3);
    consoleWarn.mockRestore();
  });

  it("sweepBudgetUsd defaults to uncapped (null) when unset or blank, without warning", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    delete process.env.SWEEP_BUDGET_USD;
    expect(sweepBudgetUsd()).toBeNull();

    process.env.SWEEP_BUDGET_USD = "  ";
    expect(sweepBudgetUsd()).toBeNull();

    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("sweepBudgetUsd uses an explicit override", () => {
    process.env.SWEEP_BUDGET_USD = "2.5";
    expect(sweepBudgetUsd()).toBe(2.5);
  });

  it("sweepBudgetUsd warns and disables the cap (null) on invalid values", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const invalid of ["abc", "0", "-5"]) {
      process.env.SWEEP_BUDGET_USD = invalid;
      expect(sweepBudgetUsd()).toBeNull();
    }

    expect(consoleWarn).toHaveBeenCalledTimes(3);
    consoleWarn.mockRestore();
  });
});

describe("startOrchestrationLoop", () => {
  it("fires a tick every MATCH_COOLDOWN_MINUTES", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "5";
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    startOrchestrationLoop();
    expect(prisma.user.findMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not start a second interval if already running", async () => {
    vi.useFakeTimers();
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    startOrchestrationLoop();
    startOrchestrationLoop();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("decisionWindowMs", () => {
  it("follows DECISION_WINDOW_MINUTES independently of MATCH_COOLDOWN_MINUTES", () => {
    process.env.MATCH_COOLDOWN_MINUTES = "1";
    process.env.DECISION_WINDOW_MINUTES = "60";

    expect(decisionWindowMs()).toBe(60 * 60 * 1000);
    expect(cooldownMs()).toBe(60 * 1000);
  });

  // Issue #381: the fallback must be a fixed, generous default — NOT
  // cooldownMs() — so a deployment left at MATCH_COOLDOWN_MINUTES's 1-minute
  // dev default doesn't auto-Nah a human 60 seconds after the pitch.
  it("falls back to a fixed 60-minute default when unset or blank, independent of MATCH_COOLDOWN_MINUTES, without warning", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MATCH_COOLDOWN_MINUTES = "1";

    delete process.env.DECISION_WINDOW_MINUTES;
    expect(decisionWindowMs()).toBe(60 * 60 * 1000);

    process.env.DECISION_WINDOW_MINUTES = "  ";
    expect(decisionWindowMs()).toBe(60 * 60 * 1000);

    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("warns and falls back to the fixed 60-minute default on invalid values, independent of MATCH_COOLDOWN_MINUTES", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MATCH_COOLDOWN_MINUTES = "1";

    for (const invalid of ["abc", "0", "-5"]) {
      process.env.DECISION_WINDOW_MINUTES = invalid;
      expect(decisionWindowMs()).toBe(60 * 60 * 1000);
    }

    expect(consoleWarn).toHaveBeenCalledTimes(3);
    consoleWarn.mockRestore();
  });
});

describe("forceMatchAfterSweeps (#301)", () => {
  it("defaults to 3 when unset or blank, without warning", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    delete process.env.FORCE_MATCH_AFTER_SWEEPS;
    expect(forceMatchAfterSweeps()).toBe(3);

    process.env.FORCE_MATCH_AFTER_SWEEPS = "  ";
    expect(forceMatchAfterSweeps()).toBe(3);

    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("accepts 0 as an explicit escape hatch", () => {
    process.env.FORCE_MATCH_AFTER_SWEEPS = "0";
    expect(forceMatchAfterSweeps()).toBe(0);
  });

  it("warns and falls back to the default of 3 on invalid values", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const invalid of ["abc", "-1", "1.5"]) {
      process.env.FORCE_MATCH_AFTER_SWEEPS = invalid;
      expect(forceMatchAfterSweeps()).toBe(3);
    }

    expect(consoleWarn).toHaveBeenCalledTimes(3);
    consoleWarn.mockRestore();
  });
});

describe("best-available force-match grace period (#301)", () => {
  // A first-cycle user (0 prior EXHAUSTED attempts) at the default grace
  // threshold must stay WAITING instead of being force-matched, even though
  // the caller asked for a guaranteed cycle.
  it("leaves a first-cycle guaranteed user WAITING (EXHAUSTED) instead of force-matching, at the default threshold", async () => {
    process.env.FORCE_MATCH_AFTER_SWEEPS = "3";
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(
      makeMatch({ id: "match-1", status: "REJECTED" })
    );
    vi.mocked(countExhaustedAttempts).mockResolvedValue(0);

    startMatchCycle("user-a");

    await vi.waitFor(() => {
      expect(completeMatchAttempt).toHaveBeenCalledWith(
        "attempt-1",
        "EXHAUSTED",
        ["match-1"],
        undefined,
        undefined
      );
    });
    expect(bestAvailableCandidateId).not.toHaveBeenCalled();
  });

  // Once the user has accumulated enough prior EXHAUSTED cycles, the next
  // guaranteed cycle force-pairs exactly as it always has.
  it("force-pairs once prior EXHAUSTED attempts reach the threshold", async () => {
    process.env.FORCE_MATCH_AFTER_SWEEPS = "3";
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(
      makeMatch({ id: "match-1", status: "REJECTED" })
    );
    vi.mocked(countExhaustedAttempts).mockResolvedValue(3);
    vi.mocked(bestAvailableCandidateId).mockResolvedValue("user-z");
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ id: "match-forced", status: "MATCHED", userAId: "user-a", userBId: "user-z" })
    );

    startMatchCycle("user-a");

    await vi.waitFor(() => {
      expect(completeMatchAttempt).toHaveBeenCalledWith(
        "attempt-1",
        "FORCED",
        ["match-1", "match-forced"],
        undefined,
        undefined
      );
    });
  });

  // FORCE_MATCH_AFTER_SWEEPS=0 is the documented escape hatch: force-pairs on
  // the very first guaranteed cycle, reproducing pre-#301 behavior, without
  // even consulting countExhaustedAttempts.
  it("FORCE_MATCH_AFTER_SWEEPS=0 force-pairs on the first guaranteed cycle", async () => {
    process.env.FORCE_MATCH_AFTER_SWEEPS = "0";
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(
      makeMatch({ id: "match-1", status: "REJECTED" })
    );
    vi.mocked(bestAvailableCandidateId).mockResolvedValue("user-z");
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ id: "match-forced", status: "MATCHED", userAId: "user-a", userBId: "user-z" })
    );

    startMatchCycle("user-a");

    await vi.waitFor(() => {
      expect(completeMatchAttempt).toHaveBeenCalledWith(
        "attempt-1",
        "FORCED",
        ["match-1", "match-forced"],
        undefined,
        undefined
      );
    });
    expect(countExhaustedAttempts).not.toHaveBeenCalled();
  });

  // The grace period only gates the guarantee — a negotiation-turn failure
  // (#339) must still fall through to the fallback immediately, regardless of
  // how many EXHAUSTED cycles this user has.
  it("still forces immediately on a negotiation-turn failure, ignoring the grace period", async () => {
    process.env.FORCE_MATCH_AFTER_SWEEPS = "3";
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockRejectedValue(
      new NegotiationTurnFailure("boom", [], 0.01, 500, new Error("boom"))
    );
    vi.mocked(countExhaustedAttempts).mockResolvedValue(0);
    vi.mocked(bestAvailableCandidateId).mockResolvedValue("user-z");
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ id: "match-forced", status: "MATCHED", userAId: "user-a", userBId: "user-z" })
    );

    await runOrchestrationTick();

    expect(bestAvailableCandidateId).toHaveBeenCalled();
    expect(countExhaustedAttempts).not.toHaveBeenCalled();
  });

  // Regression: a guaranteed cycle (manual find-match) that hits a
  // negotiation-turn failure while still inside the grace period must still
  // get the full guarantee — including the last-resort re-admit pass — not
  // just the first automatic fallback pass. Before the fix, the last-resort
  // pass was gated on `guaranteeCleared` alone, so a failure inside the grace
  // period silently fell through to FAILED instead of forcing a match.
  it("still runs the last-resort re-admit pass on a guaranteed cycle's negotiation-turn failure inside the grace period", async () => {
    process.env.FORCE_MATCH_AFTER_SWEEPS = "3";
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockRejectedValue(
      new NegotiationTurnFailure("boom", [], 0.01, 500, new Error("boom"))
    );
    vi.mocked(countExhaustedAttempts).mockResolvedValue(0);
    // First (automatic) pass finds nobody; second (last-resort, rejected
    // candidates re-admitted) pass finds user-z.
    vi.mocked(bestAvailableCandidateId).mockResolvedValueOnce(null).mockResolvedValueOnce("user-z");
    vi.mocked(forceMatchAndPersist).mockResolvedValue(
      makeMatch({ id: "match-forced", status: "MATCHED", userAId: "user-a", userBId: "user-z" })
    );

    startMatchCycle("user-a");

    await vi.waitFor(() => {
      expect(completeMatchAttempt).toHaveBeenCalledWith(
        "attempt-1",
        "FAILED",
        ["match-forced"],
        expect.objectContaining({ reason: "negotiation_turn" }),
        undefined
      );
    });
    expect(bestAvailableCandidateId).toHaveBeenCalledTimes(2);
  });

  // A passive sweep (guaranteeMatch=false, no failure) never consults the
  // grace period at all — it never force-matched before #301 and still
  // shouldn't.
  it("never queries countExhaustedAttempts on a passive sweep", async () => {
    process.env.FORCE_MATCH_AFTER_SWEEPS = "3";
    vi.mocked(prisma.user.findMany).mockResolvedValue([waitingUser("user-a")] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(waitingUser("user-a") as never);
    vi.mocked(scoreCandidates).mockResolvedValue(scored(["user-b"]));
    vi.mocked(negotiateAndPersist).mockResolvedValue(
      makeMatch({ id: "match-1", status: "REJECTED" })
    );

    await runOrchestrationTick();

    expect(countExhaustedAttempts).not.toHaveBeenCalled();
    expect(bestAvailableCandidateId).not.toHaveBeenCalled();
  });
});
