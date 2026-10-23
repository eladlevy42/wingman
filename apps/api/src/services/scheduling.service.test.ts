import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Match } from "@wingman/database";

vi.mock("@wingman/database", () => ({
  prisma: {
    match: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      updateMany: vi.fn(),
    },
  },
  // The tombstone id the guards under test exclude by identity (docs/adr/0040).
  DELETED_USER_ID: "00000000-0000-4000-8000-000000000000",
}));

vi.mock("./notification.service", () => ({
  notificationService: { send: vi.fn() },
}));

vi.mock("./audit.service", () => ({ recordEvent: vi.fn() }));

import { prisma } from "@wingman/database";
import { notificationService } from "./notification.service";
import { recordEvent } from "./audit.service";
import {
  generateCandidateSlots,
  startTimeSelection,
  submitAvailability,
  scheduleFallback,
  timeSelectionView,
  SlotNotOfferedError,
  MatchNotChoosingTimesError,
  CANDIDATE_SLOT_COUNT,
  BLIND_DATE_VENUES,
} from "./scheduling.service";
import { MatchOwnershipError } from "./match.service";

const SLOT_1 = "2026-02-01T19:00:00.000Z";
const SLOT_2 = "2026-02-02T19:00:00.000Z";
const SLOT_3 = "2026-02-03T19:00:00.000Z";
const FIVE = [SLOT_1, SLOT_2, SLOT_3, "2026-02-04T19:00:00.000Z", "2026-02-05T19:00:00.000Z"];

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
    venue: null,
    dateTime: null,
    candidateSlots: null,
    proposerId: null,
    proposedSlots: null,
    ...overrides,
  } as Match;
}

// A match already in CHOOSING_TIMES with user-a as the proposer and the shared
// five slots offered.
function choosingMatch(overrides: Partial<Match> = {}): Match {
  return makeMatch({
    candidateSlots: JSON.stringify(FIVE),
    proposerId: "user-a",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCH_COOLDOWN_MINUTES = "1";
  // Matches real Prisma's updateMany, which always resolves { count }. Tests
  // exercising the "lost the race" path override this with count: 0.
  vi.mocked(prisma.match.updateMany).mockResolvedValue({ count: 1 } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("generateCandidateSlots", () => {
  it("returns CANDIDATE_SLOT_COUNT distinct, strictly increasing future slots", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const slots = generateCandidateSlots(now);

    expect(slots).toHaveLength(CANDIDATE_SLOT_COUNT);
    for (let i = 0; i < slots.length; i++) {
      expect(slots[i].getTime()).toBeGreaterThan(now.getTime());
      if (i > 0) expect(slots[i].getTime()).toBeGreaterThan(slots[i - 1].getTime());
    }
  });
});

describe("startTimeSelection", () => {
  it("offers slots, picks a random proposer, and moves both users to CHOOSING_TIMES", async () => {
    const match = makeMatch({ candidateSlots: null });

    await startTimeSelection(match);

    const updateCall = vi
      .mocked(prisma.match.updateMany)
      .mock.calls.find((c) => c[0].data.candidateSlots !== undefined)?.[0];
    expect(updateCall?.where).toEqual({ id: "match-1", candidateSlots: null });
    const stored = JSON.parse(updateCall?.data.candidateSlots as string) as string[];
    expect(stored).toHaveLength(CANDIDATE_SLOT_COUNT);
    expect(["user-a", "user-b"]).toContain(updateCall?.data.proposerId);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-a", "user-b"] } },
      data: { matchingState: "CHOOSING_TIMES" },
    });
  });

  it("is a no-op when slots were already offered", async () => {
    await startTimeSelection(choosingMatch());

    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  // #552: scheduling.service is a matchingState writer too — the issue's list
  // of known writers misses it, but "every transition writes an event" holds.
  it("records the MATCHED -> CHOOSING_TIMES transition for both users", async () => {
    await startTimeSelection(makeMatch({ candidateSlots: null }));

    for (const userId of ["user-a", "user-b"]) {
      expect(recordEvent).toHaveBeenCalledWith(
        "MATCHING_STATE_CHANGED",
        { from: "MATCHED", to: "CHOOSING_TIMES", trigger: "times_started", matchId: "match-1" },
        { userId }
      );
    }
  });

  // A concurrent resolveMatchById + resolver-sweep call can both pass the
  // in-memory `match.candidateSlots` check with the same stale snapshot; only
  // the guarded UPDATE's WHERE clause (evaluated atomically by the database)
  // decides who actually wins (#312).
  it("does not re-roll the proposer or slate when the guarded write loses the race", async () => {
    vi.mocked(prisma.match.updateMany).mockResolvedValueOnce({ count: 0 } as never);
    const match = makeMatch({ candidateSlots: null });

    await startTimeSelection(match);

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("submitAvailability — proposer", () => {
  it("forwards up to three of the offered slots and keeps waiting", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(choosingMatch() as never);

    const result = await submitAvailability("match-1", "user-a", [SLOT_2, SLOT_1]);

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: "match-1", proposedSlots: null },
      data: { proposedSlots: JSON.stringify([SLOT_2, SLOT_1]) },
    });
    expect(result).toEqual({ waiting: true, matchingState: "CHOOSING_TIMES" });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent — a re-submission after picking is discarded", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(
      choosingMatch({ proposedSlots: JSON.stringify([SLOT_1]) }) as never
    );

    const result = await submitAvailability("match-1", "user-a", [SLOT_2, SLOT_3]);

    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ waiting: true, matchingState: "CHOOSING_TIMES" });
  });

  it("rejects picks that are not among the offered slots", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(
      choosingMatch({ candidateSlots: JSON.stringify([SLOT_1]) }) as never
    );

    await expect(submitAvailability("match-1", "user-a", [SLOT_2])).rejects.toBeInstanceOf(
      SlotNotOfferedError
    );
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });

  // #552: only the forward that actually landed is an event — the idempotence
  // guard's loser proposed nothing.
  it("records TIMES_PROPOSED with the forwarded count, and nothing on a discarded re-submit", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(choosingMatch() as never);

    await submitAvailability("match-1", "user-a", [SLOT_2, SLOT_1]);

    expect(recordEvent).toHaveBeenCalledWith(
      "TIMES_PROPOSED",
      { matchId: "match-1", slotCount: 2 },
      { userId: "user-a" }
    );

    vi.mocked(recordEvent).mockClear();
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(
      choosingMatch({ proposedSlots: JSON.stringify([SLOT_1]) }) as never
    );

    await submitAvailability("match-1", "user-a", [SLOT_2, SLOT_3]);

    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe("submitAvailability — chooser", () => {
  it("locks in the date from the one slot the chooser picks", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(
      choosingMatch({ proposedSlots: JSON.stringify([SLOT_1, SLOT_2, SLOT_3]) }) as never
    );

    const result = await submitAvailability("match-1", "user-b", [SLOT_2]);

    const scheduleCall = vi
      .mocked(prisma.match.updateMany)
      .mock.calls.find((c) => c[0].data.dateTime !== undefined);
    expect(scheduleCall?.[0].where).toEqual({ id: "match-1", venue: null });
    expect(scheduleCall?.[0].data.dateTime).toEqual(new Date(SLOT_2));
    expect(BLIND_DATE_VENUES).toContain(scheduleCall?.[0].data.venue);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-a", "user-b"] } },
      data: { matchingState: "DATE_ASSIGNED" },
    });
    expect(notificationService.send).toHaveBeenCalledTimes(2);
    // Date assignment sends its own notification type — not MATCH_FOUND, which
    // is reserved for negotiation success (orchestration.service).
    expect(notificationService.send).toHaveBeenCalledWith(
      "user-a",
      "DATE_ASSIGNED",
      expect.objectContaining({ matchId: "match-1" })
    );
    expect(notificationService.send).toHaveBeenCalledWith(
      "user-b",
      "DATE_ASSIGNED",
      expect.objectContaining({ matchId: "match-1" })
    );
    expect(result).toEqual({ waiting: false, matchingState: "DATE_ASSIGNED" });
  });

  // #552: locking in the date records the chooser's action and, via assignDate,
  // the CHOOSING_TIMES -> DATE_ASSIGNED transition for both users.
  it("records TIMES_CHOSEN and the transition to DATE_ASSIGNED for both users", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(
      choosingMatch({ proposedSlots: JSON.stringify([SLOT_1, SLOT_2, SLOT_3]) }) as never
    );

    await submitAvailability("match-1", "user-b", [SLOT_2]);

    expect(recordEvent).toHaveBeenCalledWith(
      "TIMES_CHOSEN",
      { matchId: "match-1" },
      { userId: "user-b" }
    );
    for (const userId of ["user-a", "user-b"]) {
      expect(recordEvent).toHaveBeenCalledWith(
        "MATCHING_STATE_CHANGED",
        {
          from: "CHOOSING_TIMES",
          to: "DATE_ASSIGNED",
          trigger: "date_assigned",
          matchId: "match-1",
        },
        { userId }
      );
    }
  });

  it("rejects a slot that is not among the proposer's picks", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(
      choosingMatch({ proposedSlots: JSON.stringify([SLOT_1, SLOT_2]) }) as never
    );

    await expect(submitAvailability("match-1", "user-b", [SLOT_3])).rejects.toBeInstanceOf(
      SlotNotOfferedError
    );
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a pick before the proposer has forwarded any slots", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(choosingMatch() as never);

    await expect(submitAvailability("match-1", "user-b", [SLOT_1])).rejects.toBeInstanceOf(
      MatchNotChoosingTimesError
    );
  });

  it("does not double-book when the guarded schedule loses the race", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(
      choosingMatch({ proposedSlots: JSON.stringify([SLOT_1]) }) as never
    );
    vi.mocked(prisma.match.updateMany).mockResolvedValue({ count: 0 } as never);

    await submitAvailability("match-1", "user-b", [SLOT_1]);

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(notificationService.send).not.toHaveBeenCalled();
    // #552: the discarded pick scheduled nothing — crediting the chooser with
    // TIMES_CHOSEN here would claim a date the winner (e.g. the sweep's
    // scheduleFallback) actually set.
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe("submitAvailability — guards", () => {
  it("rejects a user who is not a participant", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(choosingMatch() as never);

    await expect(submitAvailability("match-1", "stranger", [SLOT_1])).rejects.toBeInstanceOf(
      MatchOwnershipError
    );
  });

  it("rejects a submission before the match is choosing times", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(
      makeMatch({ candidateSlots: null, proposerId: null }) as never
    );

    await expect(submitAvailability("match-1", "user-a", [SLOT_1])).rejects.toBeInstanceOf(
      MatchNotChoosingTimesError
    );
  });

  it("throws when the match does not exist", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValueOnce(null as never);

    await expect(submitAvailability("missing", "user-a", [SLOT_1])).rejects.toBeInstanceOf(
      MatchNotChoosingTimesError
    );
  });
});

describe("scheduleFallback", () => {
  it("schedules the earliest proposed slot when the proposer picked but the chooser didn't", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValue(
      choosingMatch({ proposedSlots: JSON.stringify([SLOT_3, SLOT_2]) }) as never
    );

    await expect(scheduleFallback("match-1")).resolves.toBe(true);
    const scheduleCall = vi
      .mocked(prisma.match.updateMany)
      .mock.calls.find((c) => c[0].data.dateTime !== undefined);
    expect(scheduleCall?.[0].data.dateTime).toEqual(new Date(SLOT_2));
    // scheduleFallback shares assignDate with the chooser-picks-a-slot path — same
    // notification type applies here too.
    expect(notificationService.send).toHaveBeenCalledWith(
      "user-a",
      "DATE_ASSIGNED",
      expect.objectContaining({ matchId: "match-1" })
    );
  });

  it("schedules the earliest candidate slot when the proposer never picked", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValue(
      choosingMatch({ candidateSlots: JSON.stringify([SLOT_2, SLOT_1, SLOT_3]) }) as never
    );

    await expect(scheduleFallback("match-1")).resolves.toBe(true);
    const scheduleCall = vi
      .mocked(prisma.match.updateMany)
      .mock.calls.find((c) => c[0].data.dateTime !== undefined);
    expect(scheduleCall?.[0].data.dateTime).toEqual(new Date(SLOT_1));
  });

  it("does nothing when the date is already scheduled", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValue(
      choosingMatch({ venue: "Puaa", dateTime: new Date(SLOT_1) }) as never
    );

    await expect(scheduleFallback("match-1")).resolves.toBe(false);
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
  });
});

describe("timeSelectionView", () => {
  it("gives the proposer their candidate slots and submitted flag", () => {
    const match = choosingMatch({ proposedSlots: JSON.stringify([SLOT_1]) });

    expect(timeSelectionView(match, "user-a")).toEqual({
      timeRole: "proposer",
      candidateSlots: FIVE,
      proposedSlots: [SLOT_1],
      hasSubmittedAvailability: true,
    });
  });

  it("gives the chooser the proposer's slots to pick from", () => {
    const match = choosingMatch({ proposedSlots: JSON.stringify([SLOT_1, SLOT_2]) });

    expect(timeSelectionView(match, "user-b")).toEqual({
      timeRole: "chooser",
      candidateSlots: FIVE,
      proposedSlots: [SLOT_1, SLOT_2],
      hasSubmittedAvailability: false,
    });
  });
});
