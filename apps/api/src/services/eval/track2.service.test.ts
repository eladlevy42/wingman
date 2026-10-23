import { describe, expect, it, vi, beforeEach } from "vitest";
import { EvalRunConfigSchema } from "@wingman/shared";
import type { EvalRunContext } from "./types";

vi.mock("@wingman/database", () => ({
  prisma: {
    goldenPair: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../negotiation.service", () => ({
  loadParticipant: vi.fn(),
}));

vi.mock("../match.service", () => ({
  createMatch: vi.fn(),
}));

vi.mock("../../agents/negotiation.agent", () => ({
  runNegotiation: vi.fn(),
  // Deterministic serializer used to brief the groundedness judge — the real
  // one is pure JSON.stringify; a stub keeps this test decoupled from it.
  serializeParticipantProfile: vi.fn((p: { name: string }) => `profile:${p.name}`),
  // buildTrack2LogRecord scans the transcript with this (#420); the real
  // detector is exercised in negotiation.agent.test.ts. Clean by default here.
  detectTurnViolations: vi.fn(() => []),
}));

vi.mock("../../agents/evalJudge.agent", () => ({
  judgeNegotiation: vi.fn(),
}));

vi.mock("../../agents/consistencyJudge.agent", () => ({
  judgeDealbreakerConsistency: vi.fn(),
}));

vi.mock("../../agents/groundednessJudge.agent", () => ({
  judgeGroundedness: vi.fn(),
  judgeCrossGroundedness: vi.fn(),
}));

import { prisma } from "@wingman/database";
import { loadParticipant } from "../negotiation.service";
import { createMatch } from "../match.service";
import { runNegotiation } from "../../agents/negotiation.agent";
import { judgeNegotiation } from "../../agents/evalJudge.agent";
import { judgeDealbreakerConsistency } from "../../agents/consistencyJudge.agent";
import { judgeGroundedness, judgeCrossGroundedness } from "../../agents/groundednessJudge.agent";
import { runTrack2 } from "./track2.service";

// zod's uuid() only checks the 8-4-4-4-12 hex shape, not RFC version/variant
// nibbles, so plain hex-padded ids are valid without pulling in a uuid lib.
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function makeCtx(overrides: Partial<EvalRunContext> = {}): EvalRunContext {
  return {
    config: EvalRunConfigSchema.parse({}),
    shouldStop: () => false,
    onCase: () => {},
    ...overrides,
  };
}

function goldenPair(
  overrides: Partial<{
    id: string;
    userAId: string;
    userBId: string;
    goldenScore: number;
    category: string;
  }> = {}
) {
  return {
    id: uuid(1),
    userAId: uuid(2),
    userBId: uuid(3),
    goldenScore: 8,
    category: "compatible",
    createdAt: new Date(),
    ...overrides,
  };
}

function negotiationResult(
  overrides: Partial<{ scoreA: number; scoreB: number; matched: boolean }> = {}
) {
  return {
    deliberationLog: [{ speaker: "Alex's agent", content: "hi" }],
    scoreA: 8,
    scoreB: 8,
    matched: true,
    rationale: "Great match.",
    costUsd: 0.01,
    durationMs: 500,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadParticipant).mockImplementation(
    (userId: string) =>
      Promise.resolve({ userId, name: "Someone", profile: {}, wanted: {} }) as never
  );
  vi.mocked(createMatch).mockResolvedValue({} as never);
  vi.mocked(judgeNegotiation).mockResolvedValue({
    score: 8,
    rationale: "Judge agrees.",
    costUsd: 0.002,
    durationMs: 200,
  });
  vi.mocked(judgeDealbreakerConsistency).mockResolvedValue({
    aDealbreakerViolated: false,
    aConsistent: true,
    bDealbreakerViolated: false,
    bConsistent: true,
    explanation: "No dealbreakers came up.",
    costUsd: 0.001,
    durationMs: 100,
  });
  vi.mocked(judgeGroundedness).mockResolvedValue({
    totalClaims: 0,
    ungroundedClaims: [],
    costUsd: 0,
    durationMs: 0,
  });
  vi.mocked(judgeCrossGroundedness).mockResolvedValue({
    totalClaims: 0,
    ungroundedClaims: [],
    costUsd: 0,
    durationMs: 0,
  });
});

describe("runTrack2", () => {
  it("computes deltaA/deltaB against the golden score", async () => {
    const pair = goldenPair({ goldenScore: 7 });
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([pair] as never);
    vi.mocked(runNegotiation).mockResolvedValue(
      negotiationResult({ scoreA: 9, scoreB: 6, matched: false }) as never
    );

    const { result } = await runTrack2(makeCtx());

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pairId: pair.id,
      goldenScore: 7,
      scoreA: 9,
      scoreB: 6,
      deltaA: 2,
      deltaB: -1,
      judgeScore: 8,
      judgeRationale: "Judge agrees.",
    });
    expect(result[0].transcript).toContain("Alex's agent: hi");
    expect(result[0].costUsd).toBeCloseTo(0.013);
  });

  it("records band agreement from the mean score, not a per-side point target (#398)", async () => {
    // compatible band is 7-9; mean of 8 and 7 -> 7.5 -> rounds to 8 -> in band.
    const inBand = goldenPair({ category: "compatible" });
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([inBand] as never);
    vi.mocked(runNegotiation).mockResolvedValue(
      negotiationResult({ scoreA: 8, scoreB: 7 }) as never
    );
    let result = (await runTrack2(makeCtx())).result;
    expect(result[0]).toMatchObject({ category: "compatible", bandAgreement: true });

    // mean of 8 and 2 -> 5 -> borderline band, so a "compatible" golden is out
    // of band even though scoreA alone would have looked in-band.
    vi.clearAllMocks();
    vi.mocked(loadParticipant).mockImplementation(
      (userId: string) =>
        Promise.resolve({ userId, name: "Someone", profile: {}, wanted: {} }) as never
    );
    vi.mocked(createMatch).mockResolvedValue({} as never);
    vi.mocked(judgeNegotiation).mockResolvedValue({
      score: 5,
      rationale: "",
      costUsd: 0,
      durationMs: 0,
    });
    vi.mocked(judgeDealbreakerConsistency).mockResolvedValue({
      aDealbreakerViolated: false,
      aConsistent: true,
      bDealbreakerViolated: false,
      bConsistent: true,
      explanation: "",
      costUsd: 0,
      durationMs: 0,
    });
    vi.mocked(judgeGroundedness).mockResolvedValue({
      totalClaims: 0,
      ungroundedClaims: [],
      costUsd: 0,
      durationMs: 0,
    });
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([inBand] as never);
    vi.mocked(runNegotiation).mockResolvedValue(
      negotiationResult({ scoreA: 8, scoreB: 2 }) as never
    );
    result = (await runTrack2(makeCtx())).result;
    expect(result[0]).toMatchObject({ category: "compatible", bandAgreement: false });
  });

  // GoldenPair.category is a raw String column; by the time it's read the
  // pair's paid negotiation/judge calls have already run, so a corrupted value
  // must degrade to "no band verdict" for that pair rather than throwing away
  // the whole run's accumulated results.
  it("skips the band verdict (and keeps the run alive) on an invalid category", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const corrupted = goldenPair({ category: "NOT_A_CATEGORY" as never });
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([corrupted] as never);
    vi.mocked(runNegotiation).mockResolvedValue(
      negotiationResult({ scoreA: 8, scoreB: 7 }) as never
    );

    const { result } = await runTrack2(makeCtx());

    expect(result).toHaveLength(1);
    expect(result[0].category).toBeUndefined();
    expect(result[0].bandAgreement).toBeUndefined();
    expect(result[0].scoreA).toBe(8);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("includes the dealbreaker consistency judge's verdict per pair", async () => {
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([goldenPair()] as never);
    vi.mocked(runNegotiation).mockResolvedValue(negotiationResult() as never);

    const { result } = await runTrack2(makeCtx());

    expect(result[0].dealbreakerConsistency).toEqual({
      aDealbreakerViolated: false,
      aConsistent: true,
      bDealbreakerViolated: false,
      bConsistent: true,
      explanation: "No dealbreakers came up.",
    });
  });

  it("flags an inconsistency when the transcript violates a dealbreaker but the score stayed high", async () => {
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([goldenPair()] as never);
    vi.mocked(runNegotiation).mockResolvedValue(
      negotiationResult({ scoreA: 8, scoreB: 8 }) as never
    );
    vi.mocked(judgeDealbreakerConsistency).mockResolvedValue({
      aDealbreakerViolated: true,
      aConsistent: false,
      bDealbreakerViolated: false,
      bConsistent: true,
      explanation:
        "Alex's agent stated a smoking dealbreaker was never resolved, yet scoreA was 8.",
      costUsd: 0.001,
      durationMs: 100,
    });

    const { result } = await runTrack2(makeCtx());

    expect(result[0].dealbreakerConsistency).toMatchObject({
      aDealbreakerViolated: true,
      aConsistent: false,
    });
  });

  it("passes the transcript and each side's own score into the consistency judge", async () => {
    const pair = goldenPair({ userAId: uuid(11), userBId: uuid(12) });
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([pair] as never);
    vi.mocked(loadParticipant).mockImplementation(
      (userId: string) =>
        Promise.resolve({
          userId,
          name: userId === uuid(11) ? "Alex" : "Sam",
          profile: {},
          wanted: {},
        }) as never
    );
    const negotiation = negotiationResult({ scoreA: 9, scoreB: 4 });
    vi.mocked(runNegotiation).mockResolvedValue(negotiation as never);

    await runTrack2(makeCtx());

    expect(judgeDealbreakerConsistency).toHaveBeenCalledWith(
      negotiation.deliberationLog,
      "Alex's agent",
      9,
      "Sam's agent",
      4,
      expect.any(String)
    );
  });

  it("matched mirrors the negotiation result", async () => {
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([goldenPair()] as never);
    vi.mocked(runNegotiation).mockResolvedValue(
      negotiationResult({ scoreA: 6, scoreB: 9, matched: false }) as never
    );

    const { result } = await runTrack2(makeCtx());

    expect(result[0].matched).toBe(false);
  });

  it("persists a Match for every negotiated pair", async () => {
    const pair = goldenPair();
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([pair] as never);
    vi.mocked(runNegotiation).mockResolvedValue(negotiationResult() as never);

    await runTrack2(makeCtx());

    expect(createMatch).toHaveBeenCalledWith(pair.userAId, pair.userBId, expect.anything());
  });

  it("runs for every golden pair and preserves order", async () => {
    const pairs = [
      goldenPair({ id: uuid(1), userAId: uuid(11), userBId: uuid(12) }),
      goldenPair({ id: uuid(2), userAId: uuid(21), userBId: uuid(22) }),
      goldenPair({ id: uuid(3), userAId: uuid(31), userBId: uuid(32) }),
    ];
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue(pairs as never);
    vi.mocked(runNegotiation).mockResolvedValue(negotiationResult() as never);

    const { result } = await runTrack2(makeCtx());

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.pairId)).toEqual(pairs.map((p) => p.id));
  });

  it("returns an empty array when there are no golden pairs", async () => {
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([] as never);

    const { result } = await runTrack2(makeCtx());

    expect(result).toEqual([]);
    expect(runNegotiation).not.toHaveBeenCalled();
  });

  it("stops early when the context signals shouldStop", async () => {
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([goldenPair(), goldenPair()] as never);
    vi.mocked(runNegotiation).mockResolvedValue(negotiationResult() as never);

    const { result } = await runTrack2(makeCtx({ shouldStop: () => true }));

    expect(result).toHaveLength(0);
    expect(runNegotiation).not.toHaveBeenCalled();
  });

  it("grades both agents' claims and folds them into a per-pair groundedness summary", async () => {
    const pair = goldenPair({ userAId: uuid(2), userBId: uuid(3) });
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([pair] as never);
    // Distinct names so speaker labels line up with the deliberationLog.
    vi.mocked(loadParticipant).mockImplementation(
      (userId: string) =>
        Promise.resolve({
          userId,
          name: userId === uuid(2) ? "Alex" : "Blake",
          profile: {},
          wanted: {},
        }) as never
    );
    vi.mocked(runNegotiation).mockResolvedValue(
      negotiationResult({
        deliberationLog: [
          { speaker: "Alex's agent", content: "Alex loves hiking." },
          { speaker: "Blake's agent", content: "Blake is a pro chef." },
        ],
      } as never) as never
    );
    vi.mocked(judgeGroundedness).mockImplementation((speakerName: string) =>
      Promise.resolve(
        speakerName === "Alex"
          ? { totalClaims: 2, ungroundedClaims: [], costUsd: 0.001, durationMs: 50 }
          : {
              totalClaims: 2,
              ungroundedClaims: [
                { claim: "Blake is a pro chef", reason: "not in profile", kind: "self" },
              ],
              costUsd: 0.001,
              durationMs: 50,
            }
      )
    );
    // Cross pass (#420): Alex's agent claimed Blake is a "software engineer" —
    // a fabrication about the OTHER human that only a cross-profile check
    // against Blake's profile can catch.
    vi.mocked(judgeCrossGroundedness).mockImplementation((speakerName: string) =>
      Promise.resolve(
        speakerName === "Alex"
          ? {
              totalClaims: 1,
              ungroundedClaims: [
                {
                  claim: "Blake is a software engineer",
                  reason: "Blake's profile says chef",
                  kind: "about-other",
                },
              ],
              costUsd: 0.001,
              durationMs: 50,
            }
          : { totalClaims: 1, ungroundedClaims: [], costUsd: 0.001, durationMs: 50 }
      )
    );

    const { result } = await runTrack2(makeCtx());

    expect(judgeGroundedness).toHaveBeenCalledTimes(2);
    expect(judgeCrossGroundedness).toHaveBeenCalledTimes(2);
    // Alex's agent graded against Alex's profile; Blake's against Blake's.
    expect(judgeGroundedness).toHaveBeenCalledWith(
      "Alex",
      "profile:Alex",
      ["Alex loves hiking."],
      expect.any(String)
    );
    // Alex's claims ABOUT Blake, graded against Blake's own profile.
    expect(judgeCrossGroundedness).toHaveBeenCalledWith(
      "Alex",
      "Blake",
      "profile:Blake",
      ["Alex loves hiking."],
      expect.any(String)
    );
    const g = result[0].groundedness!;
    expect(g.totalClaims).toBe(6);
    expect(g.ungroundedCount).toBe(2);
    expect(g.ungroundedRate).toBeCloseTo(2 / 6);
    expect(g.flags).toEqual([
      {
        speaker: "Blake's agent",
        claim: "Blake is a pro chef",
        reason: "not in profile",
        kind: "self",
      },
      {
        speaker: "Alex's agent",
        claim: "Blake is a software engineer",
        reason: "Blake's profile says chef",
        kind: "about-other",
      },
    ]);
    // Groundedness cost rolls into the case cost alongside negotiation + judge:
    // 0.01 negotiation + 0.002 judge + 0.001 consistency + (0.001+0.001 self +
    // 0.001+0.001 cross) groundedness.
    expect(result[0].costUsd).toBeCloseTo(0.017, 3);
  });

  it("passes the configured turns override into runNegotiation", async () => {
    vi.mocked(prisma.goldenPair.findMany).mockResolvedValue([goldenPair()] as never);
    vi.mocked(runNegotiation).mockResolvedValue(negotiationResult() as never);

    await runTrack2(makeCtx({ config: EvalRunConfigSchema.parse({ turns: 4 }) }));

    expect(runNegotiation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ turns: 4 })
    );
  });
});
