import { describe, expect, it } from "vitest";
import { scoreForCase } from "./CaseCard";

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

describe("scoreForCase", () => {
  it("track 1: score is the case's precision", () => {
    const data = {
      userId: uuid(1),
      actual: [uuid(2)],
      expected: [uuid(2), uuid(3)],
      precision: 0.5,
      costUsd: 0,
      durationMs: 10,
    };
    expect(scoreForCase(1, data)).toBe(0.5);
  });

  it("track 2: score averages scoreA, scoreB, and judgeScore over 30", () => {
    const data = {
      pairId: uuid(1),
      goldenScore: 8,
      scoreA: 9,
      scoreB: 9,
      deltaA: 1,
      deltaB: 1,
      matched: true,
      judgeScore: 9,
      judgeRationale: "great fit",
      dealbreakerConsistency: null,
      groundedness: null,
      transcript: "",
      costUsd: 0.01,
      durationMs: 100,
    };
    expect(scoreForCase(2, data)).toBeCloseTo(27 / 30);
  });

  it("track 2: treats a null judgeScore as 0 rather than throwing", () => {
    const data = {
      pairId: uuid(1),
      goldenScore: 8,
      scoreA: 9,
      scoreB: 9,
      deltaA: 1,
      deltaB: 1,
      matched: true,
      judgeScore: null,
      judgeRationale: null,
      dealbreakerConsistency: null,
      groundedness: null,
      transcript: "",
      costUsd: 0.01,
      durationMs: 100,
    };
    expect(scoreForCase(2, data)).toBeCloseTo(18 / 30);
  });

  it("track 3: score is matchCount over fieldCount", () => {
    const data = {
      userId: uuid(1),
      transcriptId: uuid(2),
      fields: [],
      matchCount: 3,
      fieldCount: 4,
      costUsd: 0,
      durationMs: 5,
    };
    expect(scoreForCase(3, data)).toBe(0.75);
  });

  it("track 3: score is 0 when there are no fields, not NaN", () => {
    const data = {
      userId: uuid(1),
      transcriptId: uuid(2),
      fields: [],
      matchCount: 0,
      fieldCount: 0,
      costUsd: 0,
      durationMs: 5,
    };
    expect(scoreForCase(3, data)).toBe(0);
  });
});
