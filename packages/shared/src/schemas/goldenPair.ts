import { z } from "zod";

// Categories for Eval Track 2 golden pairs — see docs/PRODUCT_SPEC.md section 11.
export const GoldenPairCategorySchema = z.enum(["compatible", "incompatible", "borderline"]);

export type GoldenPairCategory = z.infer<typeof GoldenPairCategorySchema>;

export const GoldenPairSchema = z.object({
  id: z.string().uuid(),
  userAId: z.string().uuid(),
  userBId: z.string().uuid(),
  // 1-10 scale; the seed generator's GOLDEN_PAIR_SCORE_RANGES currently tops
  // out at 9 for "compatible" pairs — 10 is reserved for a future perfect-match
  // case (e.g. manually curated golden pairs) rather than removed as dead range.
  goldenScore: z.number().int().min(1).max(10),
  category: GoldenPairCategorySchema,
});

export type GoldenPair = z.infer<typeof GoldenPairSchema>;

// Maps a 1-10 compatibility score to the golden category band it falls in.
// Mirrors the seed generator's GOLDEN_PAIR_SCORE_RANGES (compatible 7-9,
// incompatible 1-4, borderline 5-6); the reserved 10 rounds up into compatible.
export function categoryForScore(score: number): GoldenPairCategory {
  if (score <= 4) return "incompatible";
  if (score <= 6) return "borderline";
  return "compatible";
}

// Whether the engine's outcome landed in the golden category's band. Track 2's
// band metric (issue #398): instead of an absolute per-side delta to one
// arbitrary integer — which conflates within-band label noise with the engine's
// intended A/B score asymmetry — we bucket the engine's mean score into a band
// and check it matches the golden category. Immune to both.
//
// CAVEAT (why matchDecisionCorrect exists too): this buckets the MEAN and rounds
// it, so a couple can register bandAgreement=true while its actual match/no-match
// decision is wrong — e.g. scores 6 and 8 mean 7 -> "compatible" band = agreement,
// yet the couple does NOT match because one side is below the both-sides-≥7 gate.
// Math.round also rounds a 6.5 mean UP into "compatible". Use bandAgreement as a
// lenient calibration signal, matchDecisionCorrect for the product-truth signal.
export function bandAgreement(golden: GoldenPairCategory, meanScore: number): boolean {
  return categoryForScore(Math.round(meanScore)) === golden;
}

// Whether a golden category is one the engine SHOULD produce a match for. A
// match requires BOTH agents to score at or above the threshold (7 — see
// MATCH_THRESHOLD); only the "compatible" band clears that. "incompatible" and
// "borderline" should NOT match — a borderline couple centers at 5-6, below the
// gate (see gc10 in docs/adr/0030).
export function expectedToMatch(category: GoldenPairCategory): boolean {
  return category === "compatible";
}

// Whether the engine's ACTUAL match/no-match decision agreed with the golden
// category — the product-truth signal bandAgreement cannot see (see its caveat).
// A false result on a "compatible" couple is a false NEGATIVE (a real match the
// engine missed); on an "incompatible"/"borderline" couple, a false POSITIVE.
export function matchDecisionCorrect(category: GoldenPairCategory, matched: boolean): boolean {
  return matched === expectedToMatch(category);
}
