import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CandidateScore } from "@wingman/shared";

vi.mock("@wingman/database", () => ({
  prisma: {
    matchAttempt: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    match: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@wingman/database";
import {
  createMatchAttempt,
  completeMatchAttempt,
  countExhaustedAttempts,
  listMatchAttempts,
  getMatchAttempt,
  MatchAttemptNotFoundError,
} from "./matchAttempt.service";

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function candidateScore(overrides: Partial<CandidateScore> = {}): CandidateScore {
  return {
    candidateId: uuid(2),
    passedHardCriteria: true,
    failureReason: null,
    overlapScore: 1,
    rank: 0,
    ...overrides,
  };
}

const baseRow = {
  id: uuid(1),
  userId: uuid(9),
  status: "RUNNING",
  candidateScores: JSON.stringify([candidateScore()]),
  matchIds: "[]",
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
  completedAt: null as Date | null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createMatchAttempt", () => {
  it("persists a RUNNING attempt with the candidate pool serialized", async () => {
    vi.mocked(prisma.matchAttempt.create).mockResolvedValue(baseRow as never);
    const scores = [candidateScore()];

    await createMatchAttempt(uuid(9), scores);

    expect(prisma.matchAttempt.create).toHaveBeenCalledWith({
      data: {
        userId: uuid(9),
        status: "RUNNING",
        candidateScores: JSON.stringify(scores),
      },
    });
  });
});

describe("countExhaustedAttempts (#301)", () => {
  it("counts only this user's EXHAUSTED attempts", async () => {
    vi.mocked(prisma.matchAttempt.count).mockResolvedValue(3);

    const count = await countExhaustedAttempts(uuid(9));

    expect(prisma.matchAttempt.count).toHaveBeenCalledWith({
      where: { userId: uuid(9), status: "EXHAUSTED" },
    });
    expect(count).toBe(3);
  });
});

describe("completeMatchAttempt", () => {
  it("sets status, matchIds, and completedAt", async () => {
    vi.mocked(prisma.matchAttempt.update).mockResolvedValue(baseRow as never);

    await completeMatchAttempt(uuid(1), "MATCHED", [uuid(5)]);

    expect(prisma.matchAttempt.update).toHaveBeenCalledWith({
      where: { id: uuid(1) },
      data: {
        status: "MATCHED",
        matchIds: JSON.stringify([uuid(5)]),
        failureLog: null,
        failureError: null,
        failureReason: null,
        stoppedReason: null,
        completedAt: expect.any(Date),
      },
    });
  });

  // #307: a budget-stopped shortlist walk records why, alongside whichever
  // status the attempt actually completed with.
  it("persists a stoppedReason when the shortlist walk stopped early", async () => {
    vi.mocked(prisma.matchAttempt.update).mockResolvedValue(baseRow as never);

    await completeMatchAttempt(uuid(1), "EXHAUSTED", [], undefined, "sweep_budget");

    expect(prisma.matchAttempt.update).toHaveBeenCalledWith({
      where: { id: uuid(1) },
      data: {
        status: "EXHAUSTED",
        matchIds: "[]",
        failureLog: null,
        failureError: null,
        failureReason: null,
        stoppedReason: "sweep_budget",
        completedAt: expect.any(Date),
      },
    });
  });

  // Issue #339: a FAILED attempt persists the partial transcript and error
  // message instead of discarding them.
  it("serializes the failure log and error message for a FAILED attempt", async () => {
    vi.mocked(prisma.matchAttempt.update).mockResolvedValue(baseRow as never);
    const log = [{ speaker: "Alex's agent", content: "hi" }];

    await completeMatchAttempt(uuid(1), "FAILED", [], {
      log,
      error: "runNegotiation: a turn failed — boom",
      reason: "negotiation_turn",
    });

    expect(prisma.matchAttempt.update).toHaveBeenCalledWith({
      where: { id: uuid(1) },
      data: {
        status: "FAILED",
        matchIds: "[]",
        failureLog: JSON.stringify(log),
        failureError: "runNegotiation: a turn failed — boom",
        failureReason: "negotiation_turn",
        stoppedReason: null,
        completedAt: expect.any(Date),
      },
    });
  });
});

describe("listMatchAttempts", () => {
  it("returns summaries derived from the serialized JSON columns", async () => {
    vi.mocked(prisma.matchAttempt.findMany).mockResolvedValue([
      {
        ...baseRow,
        status: "MATCHED",
        candidateScores: JSON.stringify([
          candidateScore(),
          candidateScore({ candidateId: uuid(3) }),
        ]),
        matchIds: JSON.stringify([uuid(5)]),
        completedAt: new Date("2026-07-10T00:01:00.000Z"),
      },
    ] as never);

    const [summary] = await listMatchAttempts();

    expect(summary.candidateCount).toBe(2);
    expect(summary.negotiatedCount).toBe(1);
    expect(summary.status).toBe("MATCHED");
    expect(summary.completedAt).toBe("2026-07-10T00:01:00.000Z");
  });

  it("scopes to a userId when given", async () => {
    vi.mocked(prisma.matchAttempt.findMany).mockResolvedValue([]);

    await listMatchAttempts(uuid(9));

    expect(prisma.matchAttempt.findMany).toHaveBeenCalledWith({
      where: { userId: uuid(9) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  it("lists across all users when no userId is given", async () => {
    vi.mocked(prisma.matchAttempt.findMany).mockResolvedValue([]);

    await listMatchAttempts();

    expect(prisma.matchAttempt.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  // Issue #382: a single malformed row must not take out the whole list —
  // the #253 audit is exactly the tool reached for when something's wrong.
  it("degrades a row with malformed candidateScores JSON to a 0 count instead of throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.matchAttempt.findMany).mockResolvedValue([
      { ...baseRow, id: uuid(1), candidateScores: "{not valid json" },
      { ...baseRow, id: uuid(2) },
    ] as never);

    const summaries = await listMatchAttempts();

    expect(summaries).toHaveLength(2);
    expect(summaries[0].candidateCount).toBe(0);
    expect(summaries[1].candidateCount).toBe(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it("degrades a row with malformed matchIds JSON to a 0 count instead of throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.matchAttempt.findMany).mockResolvedValue([
      { ...baseRow, id: uuid(1), matchIds: "not json at all" },
      { ...baseRow, id: uuid(2), matchIds: JSON.stringify([uuid(5)]) },
    ] as never);

    const summaries = await listMatchAttempts();

    expect(summaries).toHaveLength(2);
    expect(summaries[0].negotiatedCount).toBe(0);
    expect(summaries[1].negotiatedCount).toBe(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it("degrades a row whose JSON parses but isn't an array to a 0 count", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.matchAttempt.findMany).mockResolvedValue([
      { ...baseRow, id: uuid(1), candidateScores: JSON.stringify({ not: "an array" }) },
    ] as never);

    const summaries = await listMatchAttempts();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].candidateCount).toBe(0);
    expect(consoleError).toHaveBeenCalled();
  });

  // Issue #382 (follow-up): a corrupted scalar column (e.g. an invalid status)
  // fails MatchAttemptSummarySchema.parse — the same failure class must not take
  // out the whole list. The malformed row is skipped; the valid rows still return.
  it("skips a row whose scalar column fails schema validation instead of throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.matchAttempt.findMany).mockResolvedValue([
      { ...baseRow, id: uuid(1), status: "NOT_A_REAL_STATUS" },
      { ...baseRow, id: uuid(2), status: "MATCHED" },
    ] as never);

    const summaries = await listMatchAttempts();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe("MATCHED");
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("getMatchAttempt", () => {
  it("throws MatchAttemptNotFoundError when the attempt doesn't exist", async () => {
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue(null as never);

    await expect(getMatchAttempt("missing")).rejects.toThrow(MatchAttemptNotFoundError);
  });

  it("joins negotiation outcomes from the referenced Match rows, in matchIds order", async () => {
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue({
      ...baseRow,
      userId: uuid(9),
      status: "EXHAUSTED",
      candidateScores: JSON.stringify([
        candidateScore({ candidateId: uuid(2), rank: 0 }),
        candidateScore({ candidateId: uuid(3), rank: 1 }),
      ]),
      matchIds: JSON.stringify([uuid(101), uuid(102)]),
      completedAt: new Date("2026-07-10T00:01:00.000Z"),
    } as never);
    vi.mocked(prisma.match.findMany).mockResolvedValue([
      {
        id: uuid(102),
        userAId: uuid(9),
        userBId: uuid(3),
        status: "REJECTED",
        scoreA: 5,
        scoreB: 6,
        deliberationLog: JSON.stringify([{ speaker: "A", content: "hi" }]),
        rationale: null,
        createdAt: new Date(),
      },
      {
        id: uuid(101),
        userAId: uuid(2),
        userBId: uuid(9),
        status: "REJECTED",
        scoreA: 4,
        scoreB: 3,
        deliberationLog: null,
        rationale: null,
        createdAt: new Date(),
      },
    ] as never);

    const detail = await getMatchAttempt(uuid(1));

    expect(detail.candidateScores).toHaveLength(2);
    expect(detail.negotiations).toHaveLength(2);
    // Order follows matchIds, not the DB query's return order.
    expect(detail.negotiations[0]).toMatchObject({ matchId: uuid(101), candidateId: uuid(2) });
    expect(detail.negotiations[1]).toMatchObject({ matchId: uuid(102), candidateId: uuid(3) });
    // A null deliberationLog (e.g. a negotiation that errored before logging) parses to [].
    expect(detail.negotiations[0].deliberationLog).toEqual([]);
    expect(detail.negotiations[1].deliberationLog).toEqual([{ speaker: "A", content: "hi" }]);
  });

  it("derives candidateId as whichever side of the Match isn't the attempt's own user", async () => {
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue({
      ...baseRow,
      userId: uuid(9),
      matchIds: JSON.stringify([uuid(101)]),
    } as never);
    vi.mocked(prisma.match.findMany).mockResolvedValue([
      {
        id: uuid(101),
        userAId: uuid(9),
        userBId: uuid(3),
        status: "MATCHED",
        scoreA: 8,
        scoreB: 8,
        deliberationLog: null,
        rationale: "Great match.",
        createdAt: new Date(),
      },
    ] as never);

    const detail = await getMatchAttempt(uuid(1));

    expect(detail.negotiations[0].candidateId).toBe(uuid(3));
  });

  it("returns an empty negotiations array without querying Match when matchIds is empty", async () => {
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue(baseRow as never);

    const detail = await getMatchAttempt(uuid(1));

    expect(detail.negotiations).toEqual([]);
    expect(prisma.match.findMany).not.toHaveBeenCalled();
  });

  it("returns a null failure when the attempt has no failureLog/failureError", async () => {
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue(baseRow as never);

    const detail = await getMatchAttempt(uuid(1));

    expect(detail.failure).toBeNull();
  });

  // Issue #339: a FAILED attempt's detail view surfaces the partial
  // transcript and error message it persisted.
  it("parses the failure log and error message for a FAILED attempt", async () => {
    const log = [{ speaker: "Alex's agent", content: "hi" }];
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue({
      ...baseRow,
      status: "FAILED",
      failureLog: JSON.stringify(log),
      failureError: "runNegotiation: a turn failed — boom",
      failureReason: "negotiation_turn",
    } as never);

    const detail = await getMatchAttempt(uuid(1));

    expect(detail.failure).toEqual({
      log,
      error: "runNegotiation: a turn failed — boom",
      reason: "negotiation_turn",
    });
  });

  // #378: rows persisted before this column existed predate the distinction
  // between the two FAILED sub-cases and were always a negotiation turn
  // throwing — default to "negotiation_turn" rather than surfacing null.
  it("defaults failure.reason to negotiation_turn for rows persisted before #378", async () => {
    const log = [{ speaker: "Alex's agent", content: "hi" }];
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue({
      ...baseRow,
      status: "FAILED",
      failureLog: JSON.stringify(log),
      failureError: "runNegotiation: a turn failed — boom",
      failureReason: null,
    } as never);

    const detail = await getMatchAttempt(uuid(1));

    expect(detail.failure?.reason).toBe("negotiation_turn");
  });

  // #307: a budget-stopped attempt's detail view surfaces why the walk ended
  // early; rows persisted before this column existed (or that ran to
  // completion) surface null rather than undefined.
  it("surfaces stoppedReason when the shortlist walk stopped early", async () => {
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue({
      ...baseRow,
      status: "EXHAUSTED",
      stoppedReason: "sweep_budget",
    } as never);

    const detail = await getMatchAttempt(uuid(1));

    expect(detail.stoppedReason).toBe("sweep_budget");
  });

  it("defaults stoppedReason to null when the walk ran uninterrupted", async () => {
    vi.mocked(prisma.matchAttempt.findUnique).mockResolvedValue(baseRow as never);

    const detail = await getMatchAttempt(uuid(1));

    expect(detail.stoppedReason).toBeNull();
  });
});
