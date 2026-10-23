import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NegotiationResult } from "@wingman/shared";
import {
  createMatch,
  getMatchById,
  decideMatch,
  MatchNotFoundError,
  MatchOwnershipError,
} from "./match.service";

vi.mock("@wingman/database", () => ({
  prisma: {
    match: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("./audit.service", () => ({ recordEvent: vi.fn() }));

import { prisma } from "@wingman/database";
import { recordEvent } from "./audit.service";

function makeResult(overrides: Partial<NegotiationResult> = {}): NegotiationResult {
  return {
    deliberationLog: [{ speaker: "Alex's agent", content: "hello" }],
    scoreA: 8,
    scoreB: 7,
    matched: true,
    rationale: "Great match, shared values and easy rapport.",
    rationaleA: null,
    rationaleB: null,
    costUsd: 0,
    durationMs: 0,
    guardRetries: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Matches real Prisma's updateMany, which always resolves { count } —
  // decideMatch reads it to tell a landed decision from a discarded re-submit.
  vi.mocked(prisma.match.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("createMatch", () => {
  it("creates a MATCHED record with scores, serialized log, and rationale", async () => {
    const result = makeResult();
    vi.mocked(prisma.match.create).mockResolvedValue({ id: "match-1" } as never);

    await createMatch("user-a", "user-b", result);

    expect(prisma.match.create).toHaveBeenCalledWith({
      data: {
        userAId: "user-a",
        userBId: "user-b",
        status: "MATCHED",
        matchType: "NEGOTIATED",
        scoreA: 8,
        scoreB: 7,
        deliberationLog: JSON.stringify(result.deliberationLog),
        rationale: result.rationale,
      },
    });
  });

  // #345: matchType defaults to NEGOTIATED, and an explicit "FORCED" (passed by
  // forceMatchAndPersist) is persisted so a best-available pairing is queryably
  // distinct from a genuine match rather than inferred from its scores.
  it("persists an explicit FORCED matchType when passed", async () => {
    const result = makeResult({ scoreA: 6, scoreB: 6 });
    vi.mocked(prisma.match.create).mockResolvedValue({ id: "match-forced" } as never);

    await createMatch("user-a", "user-b", result, "FORCED");

    expect(prisma.match.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ matchType: "FORCED" }),
    });
  });

  it("creates a REJECTED record with a null rationale", async () => {
    const result = makeResult({ matched: false, scoreB: 5, rationale: null });
    vi.mocked(prisma.match.create).mockResolvedValue({ id: "match-2" } as never);

    await createMatch("user-a", "user-b", result);

    expect(prisma.match.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "REJECTED", rationale: null }),
    });
  });

  it("serializes deliberationLog as valid JSON", async () => {
    const result = makeResult();
    vi.mocked(prisma.match.create).mockResolvedValue({ id: "match-3" } as never);

    await createMatch("user-a", "user-b", result);

    const [[{ data }]] = vi.mocked(prisma.match.create).mock.calls;
    expect(() => JSON.parse(data.deliberationLog as string)).not.toThrow();
    expect(JSON.parse(data.deliberationLog as string)).toEqual(result.deliberationLog);
  });
});

describe("getMatchById", () => {
  it("returns the match when it exists", async () => {
    const match = { id: "match-1", userAId: "user-a", userBId: "user-b", rationale: "Great fit." };
    vi.mocked(prisma.match.findUnique).mockResolvedValue(match as never);

    const result = await getMatchById("match-1");

    expect(prisma.match.findUnique).toHaveBeenCalledWith({ where: { id: "match-1" } });
    expect(result).toEqual(match);
  });

  it("returns null for an unknown matchId", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValue(null);

    const result = await getMatchById("does-not-exist");

    expect(result).toBeNull();
  });
});

describe("decideMatch", () => {
  function makeMatch(overrides: Record<string, unknown> = {}) {
    return {
      id: "match-1",
      userAId: "user-a",
      userBId: "user-b",
      decisionA: null,
      decisionB: null,
      decidedAtA: null,
      decidedAtB: null,
      ...overrides,
    };
  }

  it("throws MatchNotFoundError for an unknown matchId", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValue(null);

    await expect(decideMatch("does-not-exist", "user-a", "yeah")).rejects.toThrow(
      MatchNotFoundError
    );
  });

  it("throws MatchOwnershipError when the user is not a participant", async () => {
    vi.mocked(prisma.match.findUnique).mockResolvedValue(makeMatch() as never);

    await expect(decideMatch("match-1", "user-c", "yeah")).rejects.toThrow(MatchOwnershipError);
  });

  it("stores userA's decision and reports waiting when userB has not decided", async () => {
    vi.mocked(prisma.match.findUnique)
      .mockResolvedValueOnce(makeMatch() as never)
      .mockResolvedValueOnce(makeMatch({ decisionA: "yeah", decidedAtA: new Date() }) as never);

    const result = await decideMatch("match-1", "user-a", "yeah");

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: "match-1", decisionA: null },
      data: { decisionA: "yeah", decidedAtA: expect.any(Date) },
    });
    expect(result).toEqual({ waiting: true });
  });

  it("stores userB's decision and reports not waiting when userA already decided", async () => {
    vi.mocked(prisma.match.findUnique)
      .mockResolvedValueOnce(makeMatch({ decisionA: "yeah", decidedAtA: new Date() }) as never)
      .mockResolvedValueOnce(
        makeMatch({
          decisionA: "yeah",
          decidedAtA: new Date(),
          decisionB: "nah",
          decidedAtB: new Date(),
        }) as never
      );

    const result = await decideMatch("match-1", "user-b", "nah");

    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: "match-1", decisionB: null },
      data: { decisionB: "nah", decidedAtB: expect.any(Date) },
    });
    expect(result).toEqual({ waiting: false });
  });

  it("guards the update against a concurrent second call for the same user, so the original decision is not overwritten", async () => {
    const alreadyDecided = makeMatch({ decisionA: "yeah", decidedAtA: new Date("2020-01-01") });
    vi.mocked(prisma.match.findUnique)
      .mockResolvedValueOnce(alreadyDecided as never)
      .mockResolvedValueOnce(alreadyDecided as never);
    // The guard's WHERE misses, so the database reports no row written.
    vi.mocked(prisma.match.updateMany).mockResolvedValue({ count: 0 } as never);

    const result = await decideMatch("match-1", "user-a", "nah");

    // The where clause guards on decisionA still being null — since it
    // isn't, the database performs no write, whatever the mock returns here.
    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { id: "match-1", decisionA: null },
      data: { decisionA: "nah", decidedAtA: expect.any(Date) },
    });
    expect(result).toEqual({ waiting: true });
  });

  // #552: only the decision that actually landed is an event — a discarded
  // re-submit (the guarded UPDATE's loser) decided nothing.
  it("records PITCH_DECIDED for a landed decision, and nothing for a discarded one", async () => {
    vi.mocked(prisma.match.findUnique)
      .mockResolvedValueOnce(makeMatch() as never)
      .mockResolvedValueOnce(makeMatch({ decisionA: "yeah", decidedAtA: new Date() }) as never);

    await decideMatch("match-1", "user-a", "yeah");

    expect(recordEvent).toHaveBeenCalledWith(
      "PITCH_DECIDED",
      { matchId: "match-1", decision: "yeah" },
      { userId: "user-a" }
    );

    vi.mocked(recordEvent).mockClear();
    const alreadyDecided = makeMatch({ decisionA: "yeah", decidedAtA: new Date("2020-01-01") });
    vi.mocked(prisma.match.findUnique)
      .mockResolvedValueOnce(alreadyDecided as never)
      .mockResolvedValueOnce(alreadyDecided as never);
    vi.mocked(prisma.match.updateMany).mockResolvedValue({ count: 0 } as never);

    await decideMatch("match-1", "user-a", "nah");

    expect(recordEvent).not.toHaveBeenCalled();
  });
});
