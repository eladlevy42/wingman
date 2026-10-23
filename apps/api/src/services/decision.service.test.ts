import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Match } from "@wingman/database";

vi.mock("@wingman/database", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  // The tombstone id the guards under test exclude by identity (docs/adr/0040).
  DELETED_USER_ID: "00000000-0000-4000-8000-000000000000",
}));

vi.mock("./audit.service", () => ({ recordEvent: vi.fn() }));

// The actual scheduling (slot generation, venue pick, notifications) lives in
// scheduling.service and is covered by its own tests — here we only assert that
// the resolver routes a both-yeah match into the right scheduling call.
vi.mock("./scheduling.service", () => ({
  startTimeSelection: vi.fn(),
  scheduleFallback: vi.fn(),
}));

import { prisma, DELETED_USER_ID } from "@wingman/database";
import { startTimeSelection, scheduleFallback } from "./scheduling.service";
import { recordEvent } from "./audit.service";
import {
  runDecisionResolverTick,
  resolveMatchById,
  startDecisionResolverLoop,
  stopDecisionResolverLoop,
} from "./decision.service";

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
    createdAt: new Date("2026-01-01T00:00:00Z"),
    decisionA: null,
    decisionB: null,
    decidedAtA: null,
    decidedAtB: null,
    venue: null,
    dateTime: null,
    candidateSlots: null,
    proposerId: null,
    proposedSlots: null,
    ...overrides,
  } as Match;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCH_COOLDOWN_MINUTES = "1";
  // Unset: the decision window falls back to a fixed 60-minute default,
  // independent of MATCH_COOLDOWN_MINUTES (#381).
  delete process.env.DECISION_WINDOW_MINUTES;
  // rejectMatch reads both users' prior states for the audit event (#552).
  vi.mocked(prisma.user.findMany).mockResolvedValue([
    { id: "user-a", matchingState: "MATCHED" },
    { id: "user-b", matchingState: "MATCHED" },
  ] as never);
  // Matches real Prisma's updateMany, which always resolves { count } — the
  // guarded status flip reads it to tell the winner from a concurrent loser.
  vi.mocked(prisma.match.updateMany).mockResolvedValue({ count: 1 } as never);
});

afterEach(() => {
  stopDecisionResolverLoop();
  vi.useRealTimers();
});

describe("runDecisionResolverTick", () => {
  it("opens the choose-times step when both said yeah and no slots are offered yet", async () => {
    const match = makeMatch({ decisionA: "yeah", decisionB: "yeah", candidateSlots: null });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(startTimeSelection).toHaveBeenCalledWith(match);
    expect(scheduleFallback).not.toHaveBeenCalled();
  });

  it("falls back to auto-scheduling when times were offered but the window expired without a completed pick", async () => {
    // Issue #381: decisionWindowMs() no longer inherits MATCH_COOLDOWN_MINUTES,
    // so tests exercising expiry set an explicit, fast DECISION_WINDOW_MINUTES.
    process.env.DECISION_WINDOW_MINUTES = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
    const match = makeMatch({
      decisionA: "yeah",
      decisionB: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"),
      decidedAtB: new Date("2026-01-01T00:00:00Z"),
      candidateSlots: JSON.stringify(["2026-01-02T19:00:00.000Z"]),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(scheduleFallback).toHaveBeenCalledWith(match.id);
  });

  it("leaves an offered match alone while still within the window and the pick isn't complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    const match = makeMatch({
      decisionA: "yeah",
      decisionB: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"),
      decidedAtB: new Date("2026-01-01T00:00:15Z"),
      candidateSlots: JSON.stringify(["2026-01-02T19:00:00.000Z"]),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(scheduleFallback).not.toHaveBeenCalled();
  });

  it("rejects the match and re-queues both users when either said nah", async () => {
    const match = makeMatch({ decisionA: "nah", decidedAtA: new Date("2026-01-01T00:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: match.id, status: "MATCHED" },
      data: { status: "REJECTED" },
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-a", "user-b"] } },
      data: { matchingState: "WAITING", enteredWaitingAt: expect.any(Date) },
    });
    expect(startTimeSelection).not.toHaveBeenCalled();
  });

  // #552: a rejection is a matchingState transition, and the audit trail must
  // carry each user's true prior state — MATCHED before times were offered,
  // CHOOSING_TIMES after — not a guess.
  it("records a MATCHING_STATE_CHANGED audit event per user on rejection", async () => {
    const match = makeMatch({ decisionA: "nah", decidedAtA: new Date("2026-01-01T00:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: "user-a", matchingState: "CHOOSING_TIMES" },
      { id: "user-b", matchingState: "CHOOSING_TIMES" },
    ] as never);

    await runDecisionResolverTick();

    for (const userId of ["user-a", "user-b"]) {
      expect(recordEvent).toHaveBeenCalledWith(
        "MATCHING_STATE_CHANGED",
        { from: "CHOOSING_TIMES", to: "WAITING", trigger: "match_rejected", matchId: match.id },
        { userId }
      );
    }
  });

  // #552: resolveMatchById (fired from the decide route) and this sweep can
  // both read the same MATCHED match; the guarded flip makes the loser a true
  // no-op — before the guard, it read users already reset to WAITING and
  // recorded a false WAITING -> WAITING transition per user.
  it("records nothing and touches no user when the rejection loses the race", async () => {
    const match = makeMatch({ decisionA: "nah", decidedAtA: new Date("2026-01-01T00:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.match.updateMany).mockResolvedValue({ count: 0 } as never);

    await runDecisionResolverTick();

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("rejects a non-responder once the decision window has expired", async () => {
    process.env.DECISION_WINDOW_MINUTES = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));

    const match = makeMatch({
      decisionA: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"), // 5 min ago, window is 1 min
      decisionB: null,
      decidedAtB: null,
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: match.id, status: "MATCHED" },
      data: { status: "REJECTED" },
    });
  });

  it("treats a fully non-responded match's window as anchored to match creation", async () => {
    process.env.DECISION_WINDOW_MINUTES = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));

    const match = makeMatch({ createdAt: new Date("2026-01-01T00:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: match.id, status: "MATCHED" },
      data: { status: "REJECTED" },
    });
  });

  it("leaves an incomplete decision alone while still within the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));

    const match = makeMatch({
      decisionA: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"), // 30s ago, window is 1 min
      decisionB: null,
      decidedAtB: null,
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(startTimeSelection).not.toHaveBeenCalled();
  });

  it("only queries matches not yet resolved to a Blind Date", async () => {
    vi.mocked(prisma.match.findMany).mockResolvedValue([]);

    await runDecisionResolverTick();

    expect(prisma.match.findMany).toHaveBeenCalledWith({
      where: { status: "MATCHED", venue: null },
    });
  });

  it("logs and continues past a failure for one match", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const okMatch = makeMatch({ id: "match-ok", decisionA: "nah" });
    const failingMatch = makeMatch({ id: "match-fail", decisionA: "nah" });
    vi.mocked(prisma.match.findMany).mockResolvedValue([failingMatch, okMatch] as never);
    vi.mocked(prisma.match.updateMany)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ count: 1 } as never);

    await runDecisionResolverTick();

    expect(consoleError).toHaveBeenCalled();
    expect(prisma.match.updateMany).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("logs and does not throw when findMany itself rejects (e.g. schema/client mismatch)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.match.findMany).mockRejectedValue(new Error("Unknown argument `venue`."));

    await expect(runDecisionResolverTick()).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();

    // A rejected tick must still reset isRunning so the next tick isn't skipped.
    vi.mocked(prisma.match.findMany).mockResolvedValue([]);
    await runDecisionResolverTick();
    expect(prisma.match.findMany).toHaveBeenCalledTimes(2);
  });

  it("skips the whole sweep if the previous one is still running", async () => {
    let resolveFindMany!: (matches: Match[]) => void;
    vi.mocked(prisma.match.findMany).mockReturnValue(
      new Promise((resolve) => {
        resolveFindMany = resolve;
      }) as never
    );

    const firstTick = runDecisionResolverTick();
    const secondTick = runDecisionResolverTick();

    resolveFindMany([]);
    await Promise.all([firstTick, secondTick]);

    expect(prisma.match.findMany).toHaveBeenCalledTimes(1);
  });
});

// docs/adr/0040. A user who deleted their account can never answer Yeah/Nah, so
// the decision window on their match always expires and rejectMatch always runs
// — which makes this the path that decides whether the tombstone stays IDLE.
describe("a match with a deleted participant", () => {
  beforeEach(() => {
    process.env.DECISION_WINDOW_MINUTES = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
    vi.mocked(prisma.match.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: "user-b", matchingState: "MATCHED" },
    ] as never);
  });

  it("never moves the tombstone into the matching queue", async () => {
    const match = makeMatch({
      userAId: DELETED_USER_ID,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    // Without the id filter this WAITING write would flip the tombstone out of
    // IDLE, and the sweep would then treat a deleted account as a live seeker.
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-b"] } },
      data: { matchingState: "WAITING", enteredWaitingAt: expect.any(Date) },
    });
  });

  it("still releases the surviving participant", async () => {
    const match = makeMatch({
      userAId: DELETED_USER_ID,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: match.id, status: "MATCHED" },
      data: { status: "REJECTED" },
    });
    // One audit event, for the one participant who actually transitioned.
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      "MATCHING_STATE_CHANGED",
      expect.objectContaining({ to: "WAITING", trigger: "match_rejected" }),
      { userId: "user-b" }
    );
  });
});

describe("decision window via DECISION_WINDOW_MINUTES (#302)", () => {
  it("gives a non-responder the longer window while the cooldown stays fast", async () => {
    vi.useFakeTimers();
    process.env.DECISION_WINDOW_MINUTES = "60";
    vi.setSystemTime(new Date("2026-01-01T00:30:00Z")); // 30 min in, window is 60

    const match = makeMatch({
      decisionA: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });

  it("still rejects the non-responder once the longer window has expired", async () => {
    vi.useFakeTimers();
    process.env.DECISION_WINDOW_MINUTES = "60";
    vi.setSystemTime(new Date("2026-01-01T01:01:00Z")); // 61 min in

    const match = makeMatch({
      decisionA: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: match.id, status: "MATCHED" },
      data: { status: "REJECTED" },
    });
  });

  it("holds off the choose-times auto-schedule for the longer window too", async () => {
    vi.useFakeTimers();
    process.env.DECISION_WINDOW_MINUTES = "60";
    vi.setSystemTime(new Date("2026-01-01T00:30:00Z")); // 30 min in, window is 60

    const match = makeMatch({
      decisionA: "yeah",
      decisionB: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"),
      decidedAtB: new Date("2026-01-01T00:00:00Z"),
      candidateSlots: JSON.stringify(["2026-01-02T19:00:00.000Z"]),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(scheduleFallback).not.toHaveBeenCalled();
  });

  // Issue #381: an invalid value now falls back to the fixed 60-minute
  // default, not the (possibly 1-minute) MATCH_COOLDOWN_MINUTES-derived
  // cooldown — 5 minutes in no longer expires the window.
  it("warns and does not reject within the fixed 60-minute default on an invalid value", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    process.env.DECISION_WINDOW_MINUTES = "abc";
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z")); // 5 min in, default window is 60

    const match = makeMatch({
      decisionA: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("warns and still rejects once the fixed 60-minute default has expired on an invalid value", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    process.env.DECISION_WINDOW_MINUTES = "abc";
    vi.setSystemTime(new Date("2026-01-01T01:01:00Z")); // 61 min in, default window is 60

    const match = makeMatch({
      decisionA: "yeah",
      decidedAtA: new Date("2026-01-01T00:00:00Z"),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);

    await runDecisionResolverTick();

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: match.id, status: "MATCHED" },
      data: { status: "REJECTED" },
    });
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("keeps the resolver sweep on the cooldown cadence even with a longer window set", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "5";
    process.env.DECISION_WINDOW_MINUTES = "60";
    vi.mocked(prisma.match.findMany).mockResolvedValue([]);

    startDecisionResolverLoop();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(prisma.match.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("resolveMatchById", () => {
  it("resolves a single MATCHED, unscheduled match by id", async () => {
    const match = makeMatch({ decisionA: "yeah", decisionB: "yeah" });
    vi.mocked(prisma.match.findUnique).mockResolvedValue(match as never);

    await resolveMatchById("match-1");

    expect(prisma.match.findUnique).toHaveBeenCalledWith({ where: { id: "match-1" } });
    expect(startTimeSelection).toHaveBeenCalledWith(match);
  });

  it("ignores a match that is already scheduled (venue set)", async () => {
    const match = makeMatch({ decisionA: "yeah", decisionB: "yeah", venue: "Puaa" });
    vi.mocked(prisma.match.findUnique).mockResolvedValue(match as never);

    await resolveMatchById("match-1");

    expect(startTimeSelection).not.toHaveBeenCalled();
  });

  it("ignores an unknown match id", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValue(null as never);

    await resolveMatchById("nope");

    expect(startTimeSelection).not.toHaveBeenCalled();
  });
});

describe("startDecisionResolverLoop", () => {
  it("fires a tick every MATCH_COOLDOWN_MINUTES", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "5";
    vi.mocked(prisma.match.findMany).mockResolvedValue([]);

    startDecisionResolverLoop();
    expect(prisma.match.findMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(prisma.match.findMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(prisma.match.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not start a second interval if already running", async () => {
    vi.useFakeTimers();
    vi.mocked(prisma.match.findMany).mockResolvedValue([]);

    startDecisionResolverLoop();
    startDecisionResolverLoop();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(prisma.match.findMany).toHaveBeenCalledTimes(1);
  });
});
