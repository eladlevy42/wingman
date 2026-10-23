import { categoryForScore, expectedToMatch } from "@wingman/shared";

export interface CalibrationCase {
  pairId: string;
  goldenScore: number;
  scoreA: number;
  scoreB: number;
  matched: boolean;
}
export interface CoupleCalibration {
  pairId: string;
  intendedGoldenScore: number;
  meanA: number;
  meanB: number;
  spread: number;
  matchedRate: number;
  noisy: boolean;
}
const avg = (ns: number[]) => ns.reduce((s, n) => s + n, 0) / ns.length;

// Fold N runs (each an array of per-couple cases) into one summary per couple.
export function summarizeCalibration(runs: CalibrationCase[][]): CoupleCalibration[] {
  const byPair = new Map<string, CalibrationCase[]>();
  for (const run of runs) {
    for (const c of run) {
      const list = byPair.get(c.pairId) ?? [];
      list.push(c);
      byPair.set(c.pairId, list);
    }
  }
  return [...byPair.values()].map((cases) => {
    const perRunMean = cases.map((c) => (c.scoreA + c.scoreB) / 2);
    const spread = Math.max(...perRunMean) - Math.min(...perRunMean);
    return {
      pairId: cases[0].pairId,
      intendedGoldenScore: cases[0].goldenScore,
      meanA: avg(cases.map((c) => c.scoreA)),
      meanB: avg(cases.map((c) => c.scoreB)),
      spread,
      matchedRate: cases.filter((c) => c.matched).length / cases.length,
      noisy: spread > 2,
    };
  });
}

export interface MatchDecisionSummary {
  // Every (couple, run) match decision counted.
  cases: number;
  correct: number;
  accuracy: number;
  // Couples the engine SHOULD have matched (compatible) but didn't, in some or
  // all runs — with the fraction of runs it did match (1 - falseNegRate).
  falseNegatives: { pairId: string; matchedRate: number }[];
  // Couples the engine should NOT have matched (incompatible/borderline) but
  // did, in some or all runs.
  falsePositives: { pairId: string; matchedRate: number }[];
}

// The product-truth accuracy bandAgreement can't see (issue #420, fix #4): did
// the engine's actual match/no-match decision agree with the golden category?
// The expected outcome is derived from each couple's golden score — a compatible
// band (7-9) should match, incompatible/borderline should not. Unlike
// bandAgreement (which buckets the rounded MEAN), this reads the real decision,
// so it surfaces both false negatives (missed matches) and false positives.
export function matchDecisionSummary(runs: CalibrationCase[][]): MatchDecisionSummary {
  const byPair = new Map<string, CalibrationCase[]>();
  for (const run of runs) {
    for (const c of run) {
      const list = byPair.get(c.pairId) ?? [];
      list.push(c);
      byPair.set(c.pairId, list);
    }
  }

  let cases = 0;
  let correct = 0;
  const falseNegatives: { pairId: string; matchedRate: number }[] = [];
  const falsePositives: { pairId: string; matchedRate: number }[] = [];

  for (const list of byPair.values()) {
    const expected = expectedToMatch(categoryForScore(list[0].goldenScore));
    const matchedRate = list.filter((c) => c.matched).length / list.length;
    for (const c of list) {
      cases += 1;
      if (c.matched === expected) correct += 1;
    }
    if (expected && matchedRate < 1) falseNegatives.push({ pairId: list[0].pairId, matchedRate });
    if (!expected && matchedRate > 0) falsePositives.push({ pairId: list[0].pairId, matchedRate });
  }

  return {
    cases,
    correct,
    accuracy: cases > 0 ? correct / cases : 0,
    falseNegatives,
    falsePositives,
  };
}
