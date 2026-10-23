import { describe, expect, it } from "vitest";
import {
  bandAgreement,
  categoryForScore,
  expectedToMatch,
  matchDecisionCorrect,
} from "./goldenPair";

describe("categoryForScore", () => {
  it("maps scores to the golden category band (mirrors GOLDEN_PAIR_SCORE_RANGES)", () => {
    expect(categoryForScore(1)).toBe("incompatible");
    expect(categoryForScore(4)).toBe("incompatible");
    expect(categoryForScore(5)).toBe("borderline");
    expect(categoryForScore(6)).toBe("borderline");
    expect(categoryForScore(7)).toBe("compatible");
    expect(categoryForScore(9)).toBe("compatible");
    expect(categoryForScore(10)).toBe("compatible");
  });
});

describe("bandAgreement", () => {
  it("agrees when the rounded mean score lands in the golden band", () => {
    // compatible band 7-9: mean 7.5 rounds to 8 -> compatible
    expect(bandAgreement("compatible", 7.5)).toBe(true);
    // incompatible band 1-4
    expect(bandAgreement("incompatible", 2)).toBe(true);
    // borderline band 5-6: 5.5 rounds to 6 -> borderline
    expect(bandAgreement("borderline", 5.5)).toBe(true);
  });

  it("disagrees when the mean lands in a different band, ignoring per-side asymmetry", () => {
    // scoreA 8 / scoreB 2 -> mean 5 -> borderline, not compatible
    expect(bandAgreement("compatible", 5)).toBe(false);
    expect(bandAgreement("incompatible", 6)).toBe(false);
  });

  it("rounds a mean of exactly x.5 half-up into the next band (documented boundary)", () => {
    // Math.round is half-up: 6.5 -> 7 (compatible band 7-9), not borderline.
    expect(bandAgreement("compatible", 6.5)).toBe(true);
    expect(bandAgreement("borderline", 6.5)).toBe(false);
    // 4.5 -> 5 (borderline band 5-6), not incompatible.
    expect(bandAgreement("borderline", 4.5)).toBe(true);
    expect(bandAgreement("incompatible", 4.5)).toBe(false);
  });
});

// Fix #4: bandAgreement buckets the mean, so it can register agreement while the
// real match decision is wrong. These read the actual decision instead.
describe("expectedToMatch / matchDecisionCorrect", () => {
  it("only the compatible band is expected to produce a match", () => {
    expect(expectedToMatch("compatible")).toBe(true);
    expect(expectedToMatch("incompatible")).toBe(false);
    expect(expectedToMatch("borderline")).toBe(false);
  });

  it("scores a compatible couple that failed to match as a false negative", () => {
    // The bandAgreement blind spot: mean of 6 and 8 rounds to 7 = compatible
    // band (agreement), yet the couple does NOT match (6 < the 7 gate).
    expect(bandAgreement("compatible", 7)).toBe(true);
    expect(matchDecisionCorrect("compatible", false)).toBe(false);
    expect(matchDecisionCorrect("compatible", true)).toBe(true);
  });

  it("scores a borderline/incompatible couple that matched as a false positive", () => {
    expect(matchDecisionCorrect("borderline", true)).toBe(false);
    expect(matchDecisionCorrect("incompatible", true)).toBe(false);
    expect(matchDecisionCorrect("borderline", false)).toBe(true);
    expect(matchDecisionCorrect("incompatible", false)).toBe(true);
  });
});
