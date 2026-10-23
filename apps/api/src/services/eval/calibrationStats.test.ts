import { describe, it, expect } from "vitest";
import { summarizeCalibration, matchDecisionSummary } from "./calibrationStats";

describe("summarizeCalibration", () => {
  it("computes per-couple means, spread, matched-rate, and flags noisy anchors", () => {
    const runs = [
      [{ pairId: "p1", goldenScore: 8, scoreA: 8, scoreB: 7, matched: true }],
      [{ pairId: "p1", goldenScore: 8, scoreA: 3, scoreB: 4, matched: false }],
    ];
    const [c] = summarizeCalibration(runs);
    expect(c.pairId).toBe("p1");
    expect(c.matchedRate).toBe(0.5);
    expect(c.spread).toBeGreaterThan(2); // 7.5 vs 3.5
    expect(c.noisy).toBe(true);
  });
});

describe("matchDecisionSummary", () => {
  it("counts correct match/no-match decisions and lists false negatives and positives", () => {
    const runs = [
      [
        // compatible (golden 8), correctly matched
        { pairId: "compat-ok", goldenScore: 8, scoreA: 8, scoreB: 8, matched: true },
        // compatible (golden 7), missed the match -> false negative
        { pairId: "compat-miss", goldenScore: 7, scoreA: 6, scoreB: 8, matched: false },
        // incompatible (golden 2), correctly not matched
        { pairId: "incompat-ok", goldenScore: 2, scoreA: 1, scoreB: 2, matched: false },
        // borderline (golden 6), matched -> false positive
        { pairId: "border-fp", goldenScore: 6, scoreA: 7, scoreB: 7, matched: true },
      ],
    ];

    const s = matchDecisionSummary(runs);

    expect(s.cases).toBe(4);
    expect(s.correct).toBe(2); // compat-ok + incompat-ok
    expect(s.accuracy).toBe(0.5);
    expect(s.falseNegatives.map((f) => f.pairId)).toEqual(["compat-miss"]);
    expect(s.falsePositives.map((f) => f.pairId)).toEqual(["border-fp"]);
  });

  it("aggregates a couple's decisions across runs by matched-rate", () => {
    const runs = [
      [{ pairId: "p", goldenScore: 8, scoreA: 8, scoreB: 8, matched: true }],
      [{ pairId: "p", goldenScore: 8, scoreA: 6, scoreB: 8, matched: false }],
    ];

    const s = matchDecisionSummary(runs);

    expect(s.cases).toBe(2);
    expect(s.correct).toBe(1); // matched once, missed once
    // Compatible couple that matched in only half its runs is a false negative.
    expect(s.falseNegatives).toEqual([{ pairId: "p", matchedRate: 0.5 }]);
    expect(s.falsePositives).toEqual([]);
  });
});
