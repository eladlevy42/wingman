import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Match, FollowUp } from "@wingman/database";

vi.mock("@wingman/database", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
    },
    followUp: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
    },
  },
  // The tombstone id the guards under test exclude by identity (docs/adr/0040).
  DELETED_USER_ID: "00000000-0000-4000-8000-000000000000",
}));

vi.mock("./notification.service", () => ({
  notificationService: { send: vi.fn() },
}));

vi.mock("./audit.service", () => ({ recordEvent: vi.fn() }));

import { prisma, DELETED_USER_ID } from "@wingman/database";
import { notificationService } from "./notification.service";
import { recordEvent } from "./audit.service";
import {
  runFollowUpTick,
  startFollowUpLoop,
  stopFollowUpLoop,
  markDebriefed,
} from "./followup.service";

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
    decisionA: "yeah",
    decisionB: "yeah",
    decidedAtA: new Date("2026-01-01T00:00:00Z"),
    decidedAtB: new Date("2026-01-01T00:00:00Z"),
    venue: "Aroma Coffee",
    dateTime: new Date("2026-01-04T20:00:00Z"),
    ...overrides,
  } as Match;
}

function makeFollowUp(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: "followup-1",
    userId: "user-a",
    matchId: "match-1",
    state: "AWAITING_DATE",
    ...overrides,
  } as FollowUp;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCH_COOLDOWN_MINUTES = "1440"; // prod-equivalent: 1 window = 1 day
  // Unset: the decision window falls back to a fixed 60-minute default,
  // independent of MATCH_COOLDOWN_MINUTES (#381). reminderWindowMs() takes
  // Math.max(decisionWindowMs(), cooldownMs()), and every test in this file
  // uses a MATCH_COOLDOWN_MINUTES >= 60, so cooldownMs() still wins here.
  delete process.env.DECISION_WINDOW_MINUTES;
});

afterEach(() => {
  stopFollowUpLoop();
  vi.useRealTimers();
});

describe("markDebriefed", () => {
  it("updates the FollowUp row for userId/matchId to DEBRIEFED", async () => {
    vi.mocked(prisma.followUp.update).mockResolvedValue(
      makeFollowUp({ state: "DEBRIEFED" }) as never
    );

    await markDebriefed("user-a", "match-1");

    expect(prisma.followUp.update).toHaveBeenCalledWith({
      where: { userId_matchId: { userId: "user-a", matchId: "match-1" } },
      data: { state: "DEBRIEFED" },
    });
  });

  it("resets the user's matchingState back to WAITING so they re-enter matching", async () => {
    vi.mocked(prisma.followUp.update).mockResolvedValue(
      makeFollowUp({ state: "DEBRIEFED" }) as never
    );

    await markDebriefed("user-a", "match-1");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-a" },
      data: { matchingState: "WAITING", enteredWaitingAt: expect.any(Date) },
    });
  });

  // #552: the debrief's terminal act is two audit events — the debrief itself,
  // and the state transition it causes.
  it("records DEBRIEF_COMPLETED and the DATE_ASSIGNED -> WAITING transition", async () => {
    vi.mocked(prisma.followUp.update).mockResolvedValue(
      makeFollowUp({ state: "DEBRIEFED" }) as never
    );

    await markDebriefed("user-a", "match-1");

    expect(recordEvent).toHaveBeenCalledWith(
      "DEBRIEF_COMPLETED",
      { matchId: "match-1" },
      { userId: "user-a" }
    );
    expect(recordEvent).toHaveBeenCalledWith(
      "MATCHING_STATE_CHANGED",
      { from: "DATE_ASSIGNED", to: "WAITING", trigger: "debrief_completed", matchId: "match-1" },
      { userId: "user-a" }
    );
  });
});

describe("runFollowUpTick", () => {
  it("creates a FollowUp row for each user of an assigned match", async () => {
    const match = makeMatch({ dateTime: new Date("2026-06-01T00:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockImplementation(
      ({ create }) =>
        Promise.resolve(makeFollowUp({ userId: create.userId, id: `fu-${create.userId}` })) as never
    );

    await runFollowUpTick();

    expect(prisma.match.findMany).toHaveBeenCalledWith({
      where: { status: "MATCHED", dateTime: { not: null } },
    });
    expect(prisma.followUp.upsert).toHaveBeenCalledWith({
      where: { userId_matchId: { userId: "user-a", matchId: "match-1" } },
      create: { userId: "user-a", matchId: "match-1", state: "AWAITING_DATE" },
      update: {},
    });
    expect(prisma.followUp.upsert).toHaveBeenCalledWith({
      where: { userId_matchId: { userId: "user-b", matchId: "match-1" } },
      create: { userId: "user-b", matchId: "match-1", state: "AWAITING_DATE" },
      update: {},
    });
  });

  // docs/adr/0040: erasing an account cascades away its FollowUp and
  // Notification rows. This sweep upserts both, so without the skip it would
  // recreate them for a user who no longer exists.
  it("creates nothing for the tombstone side of a match", async () => {
    const match = makeMatch({
      userAId: DELETED_USER_ID,
      dateTime: new Date("2026-06-01T00:00:00Z"),
    });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockResolvedValue(makeFollowUp() as never);

    await runFollowUpTick();

    expect(prisma.followUp.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.followUp.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_matchId: { userId: "user-b", matchId: "match-1" } },
      })
    );
    expect(notificationService.send).not.toHaveBeenCalledWith(
      DELETED_USER_ID,
      expect.anything(),
      expect.anything()
    );
  });

  it("sends PRE_DATE_REMINDER once the Blind Date is within one cooldown window", async () => {
    vi.useFakeTimers();
    // Window = reminderWindowMs() = cooldownMs() = 1h here. Set "now" to 30min
    // before the Blind Date, inside the window.
    process.env.MATCH_COOLDOWN_MINUTES = "60";
    vi.setSystemTime(new Date("2026-06-01T19:30:00Z"));
    const match = makeMatch({ dateTime: new Date("2026-06-01T20:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockResolvedValue(makeFollowUp() as never);

    await runFollowUpTick();

    expect(notificationService.send).toHaveBeenCalledWith("user-a", "PRE_DATE_REMINDER", {
      matchId: "match-1",
    });
    expect(prisma.followUp.update).not.toHaveBeenCalled();
  });

  it("does not send a reminder while still more than one cooldown window before the date", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "60"; // 1h window
    vi.setSystemTime(new Date("2026-06-01T18:00:00Z")); // 2h before the date
    const match = makeMatch({ dateTime: new Date("2026-06-01T20:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockResolvedValue(makeFollowUp() as never);

    await runFollowUpTick();

    expect(notificationService.send).not.toHaveBeenCalled();
  });

  it("widens the reminder window when DECISION_WINDOW_MINUTES is longer than the cooldown (#302)", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "60"; // sweeps hourly
    process.env.DECISION_WINDOW_MINUTES = "180"; // humans get 3h
    vi.setSystemTime(new Date("2026-06-01T18:00:00Z")); // 2h before the date
    const match = makeMatch({ dateTime: new Date("2026-06-01T20:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockResolvedValue(
      makeFollowUp({ id: "followup-widened" }) as never
    );

    await runFollowUpTick();

    // 2h out is outside the 1h cooldown window (see the test above) but
    // inside the 3h decision window — the reminder now fires.
    expect(notificationService.send).toHaveBeenCalledWith("user-a", "PRE_DATE_REMINDER", {
      matchId: "match-1",
    });
  });

  it("never narrows the reminder window below one sweep interval, even with a short decision window (#302)", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "1440"; // prod: 1-day cadence
    process.env.DECISION_WINDOW_MINUTES = "60"; // shorter than the cadence
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const match = makeMatch({ dateTime: new Date("2026-06-01T20:00:00Z") }); // 20h out
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockResolvedValue(
      makeFollowUp({ id: "followup-floor" }) as never
    );

    await runFollowUpTick();

    // A bare 1h window would be stepped over by the daily sweep (this tick is
    // "too early", the next lands after the date). The Math.max floor keeps
    // the window at one full cooldown, so the reminder still fires.
    expect(notificationService.send).toHaveBeenCalledWith("user-a", "PRE_DATE_REMINDER", {
      matchId: "match-1",
    });
  });

  it("fires the reminder on the sweep that first brings the date within one cooldown window, even at prod's slower once-a-day cadence", async () => {
    // Regression test: a fixed 3h window would be narrower than prod's 1-day
    // sweep interval and could be silently stepped over. The window must be
    // at least as wide as the sweep's own cadence so a tick can never skip it.
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "1440"; // prod: 1-day cadence
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const match = makeMatch({ dateTime: new Date("2026-06-03T20:00:00Z") }); // ~2.83 days out
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockResolvedValue(
      makeFollowUp({ id: "followup-cadence-test" }) as never
    );

    startFollowUpLoop();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // day 1: ~1.83 days out
    expect(notificationService.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // day 2: ~0.83 days out — within the 1-day window
    expect(notificationService.send).toHaveBeenCalledWith("user-a", "PRE_DATE_REMINDER", {
      matchId: "match-1",
    });
  });

  it("does not resend a reminder to a FollowUp row already reminded", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "60"; // 1h window
    vi.setSystemTime(new Date("2026-06-01T19:30:00Z"));
    const match = makeMatch({ dateTime: new Date("2026-06-01T20:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockImplementation(
      ({ create }) =>
        Promise.resolve(
          makeFollowUp({ userId: create.userId, id: `followup-dedupe-${create.userId}` })
        ) as never
    );

    await runFollowUpTick();
    await runFollowUpTick();

    expect(notificationService.send).toHaveBeenCalledTimes(2); // 2 users, first tick only
  });

  it("transitions to DATE_PASSED and sends DEBRIEF_NUDGE once the date has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00Z")); // after the Blind Date
    const match = makeMatch({ dateTime: new Date("2026-06-01T20:00:00Z") });
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockResolvedValue(
      makeFollowUp({ id: "followup-passed" }) as never
    );

    await runFollowUpTick();

    expect(prisma.followUp.update).toHaveBeenCalledWith({
      where: { id: "followup-passed" },
      data: { state: "DATE_PASSED" },
    });
    expect(notificationService.send).toHaveBeenCalledWith("user-a", "DEBRIEF_NUDGE", {
      matchId: "match-1",
    });
    expect(notificationService.send).toHaveBeenCalledWith("user-b", "DEBRIEF_NUDGE", {
      matchId: "match-1",
    });
  });

  it("leaves a FollowUp row alone once it is no longer AWAITING_DATE", async () => {
    const match = makeMatch();
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert).mockResolvedValue(
      makeFollowUp({ state: "DEBRIEFED" }) as never
    );

    await runFollowUpTick();

    expect(prisma.followUp.update).not.toHaveBeenCalled();
    expect(notificationService.send).not.toHaveBeenCalled();
  });

  it("logs and continues past a failure for one user", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const match = makeMatch();
    vi.mocked(prisma.match.findMany).mockResolvedValue([match] as never);
    vi.mocked(prisma.followUp.upsert)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(makeFollowUp({ userId: "user-b", state: "DEBRIEFED" }) as never);

    await runFollowUpTick();

    expect(consoleError).toHaveBeenCalled();
    expect(prisma.followUp.upsert).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("skips the whole sweep if the previous one is still running", async () => {
    let resolveFindMany!: (matches: Match[]) => void;
    vi.mocked(prisma.match.findMany).mockReturnValue(
      new Promise((resolve) => {
        resolveFindMany = resolve;
      }) as never
    );

    const firstTick = runFollowUpTick();
    const secondTick = runFollowUpTick();

    resolveFindMany([]);
    await Promise.all([firstTick, secondTick]);

    expect(prisma.match.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("startFollowUpLoop", () => {
  it("fires a tick every MATCH_COOLDOWN_MINUTES", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "5";
    vi.mocked(prisma.match.findMany).mockResolvedValue([]);

    startFollowUpLoop();
    expect(prisma.match.findMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(prisma.match.findMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(prisma.match.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not start a second interval if already running", async () => {
    vi.useFakeTimers();
    process.env.MATCH_COOLDOWN_MINUTES = "1";
    vi.mocked(prisma.match.findMany).mockResolvedValue([]);

    startFollowUpLoop();
    startFollowUpLoop();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(prisma.match.findMany).toHaveBeenCalledTimes(1);
  });
});
