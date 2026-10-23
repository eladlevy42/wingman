import { describe, expect, it } from "vitest";
import type { Track2Groundedness } from "@wingman/shared";
import { aggregateScore, bandAgreementRate, caseCount, ungroundedRate } from "./aggregate";

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

describe("aggregateScore", () => {
  it("returns null when there is no result", () => {
    expect(aggregateScore(1, null)).toBeNull();
  });

  it("track 1: returns meanPrecision directly", () => {
    expect(aggregateScore(1, { meanPrecision: 0.42, perUser: [] })).toBe(0.42);
  });

  it("track 2: averages the per-case score across all pairs", () => {
    const result = [
      {
        pairId: uuid(1),
        goldenScore: 8,
        scoreA: 10,
        scoreB: 10,
        deltaA: 2,
        deltaB: 2,
        matched: true,
        judgeScore: 10,
        judgeRationale: null,
        dealbreakerConsistency: null,
        groundedness: null,
        transcript: "",
        costUsd: 0,
        durationMs: 0,
      },
      {
        pairId: uuid(2),
        goldenScore: 3,
        scoreA: 2,
        scoreB: 2,
        deltaA: -1,
        deltaB: -1,
        matched: false,
        judgeScore: 2,
        judgeRationale: null,
        dealbreakerConsistency: null,
        groundedness: null,
        transcript: "",
        costUsd: 0,
        durationMs: 0,
      },
    ];
    // case 1 score = 30/30 = 1, case 2 score = 6/30 = 0.2 -> mean 0.6
    expect(aggregateScore(2, result)).toBeCloseTo(0.6);
  });

  it("track 2/3: returns null for an empty result array rather than NaN", () => {
    expect(aggregateScore(2, [])).toBeNull();
    expect(aggregateScore(3, [])).toBeNull();
  });
});

describe("ungroundedRate", () => {
  const g = (totalClaims: number, ungroundedCount: number): Track2Groundedness => ({
    totalClaims,
    ungroundedCount,
    ungroundedRate: totalClaims > 0 ? ungroundedCount / totalClaims : 0,
    flags: [],
  });

  const pair = (groundedness: Track2Groundedness | null) => ({
    pairId: uuid(1),
    goldenScore: 8,
    scoreA: 8,
    scoreB: 8,
    deltaA: 0,
    deltaB: 0,
    matched: true,
    judgeScore: 8,
    judgeRationale: null,
    dealbreakerConsistency: null,
    groundedness,
    transcript: "",
    costUsd: 0,
    durationMs: 0,
  });

  it("returns null for non-Track-2 runs", () => {
    expect(ungroundedRate(1, { meanPrecision: 1, perUser: [] })).toBeNull();
  });

  it("returns null when no pair recorded a groundedness verdict", () => {
    expect(ungroundedRate(2, [pair(null), pair(null)])).toBeNull();
  });

  it("sums ungrounded and total claims across pairs", () => {
    // (1 + 0) ungrounded / (4 + 2) total = 1/6
    expect(ungroundedRate(2, [pair(g(4, 1)), pair(g(2, 0))])).toBeCloseTo(1 / 6);
  });

  it("returns 0 when verdicts exist but counted no claims", () => {
    expect(ungroundedRate(2, [pair(g(0, 0))])).toBe(0);
  });
});

describe("bandAgreementRate", () => {
  const pair = (bandAgreement: boolean | undefined) => ({
    pairId: uuid(1),
    goldenScore: 8,
    scoreA: 8,
    scoreB: 8,
    deltaA: 0,
    deltaB: 0,
    matched: true,
    judgeScore: 8,
    judgeRationale: null,
    dealbreakerConsistency: null,
    groundedness: null,
    transcript: "",
    costUsd: 0,
    durationMs: 0,
    ...(bandAgreement === undefined ? {} : { bandAgreement }),
  });

  it("returns null for non-Track-2 runs", () => {
    expect(bandAgreementRate(1, { meanPrecision: 1, perUser: [] })).toBeNull();
  });

  it("returns null when no pair recorded a band-agreement verdict (pre-#398 runs)", () => {
    expect(bandAgreementRate(2, [pair(undefined), pair(undefined)])).toBeNull();
  });

  it("computes the share of in-band pairs", () => {
    expect(bandAgreementRate(2, [pair(true), pair(true), pair(false), pair(false)])).toBe(0.5);
  });
});

describe("caseCount", () => {
  it("track 1: counts perUser rows", () => {
    expect(
      caseCount(1, {
        meanPrecision: 1,
        perUser: [
          { userId: uuid(1), actual: [], expected: [], precision: 1, costUsd: 0, durationMs: 0 },
        ],
      })
    ).toBe(1);
  });

  it("track 2/3: counts array length", () => {
    expect(caseCount(2, [])).toBe(0);
    expect(caseCount(3, null)).toBe(0);
  });
});
