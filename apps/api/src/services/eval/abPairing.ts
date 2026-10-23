import { categoryForScore, expectedToMatch } from "@wingman/shared";

// Paired A/B design for issue #424: does the quiet-ventriloquism guard help?
//
// #422 answered this by comparing sweeps run days apart under different code —
// the new detector, a re-worded re-ask, and any engine drift all moved at once,
// so the 16/20-vs-20/20 gap could not be attributed. This module builds the
// design that can attribute it: both arms of every couple run back-to-back in
// one session, with everything except the guard held fixed.

export type Arm = "guard-off" | "guard-on";

// Arms are emitted ADJACENTLY per (couple, replicate) so the two runs of a pair
// are as close together in time as possible — that adjacency is what controls
// for drift, and it is the whole point of the design.
export interface AbRunStep {
  pairId: string;
  coupleIndex: number;
  replicate: number;
  arm: Arm;
  // Held CONSTANT within a pair: the guard must be the only difference between
  // the two runs being compared. Varied across couples and replicates so the
  // known first-mover advantage (#420, P7b) doesn't sit on one arm.
  openerSide: "a" | "b";
}

export function buildAbPlan(pairIds: string[], replicates: number): AbRunStep[] {
  const plan: AbRunStep[] = [];
  for (let coupleIndex = 0; coupleIndex < pairIds.length; coupleIndex++) {
    for (let replicate = 0; replicate < replicates; replicate++) {
      // Alternate which arm runs first. If the second run of a pair is
      // systematically advantaged (warm cache, drift within the pair), always
      // running guard-off first would bake that into the comparison.
      //
      // Alternated on coupleIndex + replicate, NOT on replicate alone: the
      // harness defaults to 1 replicate, so a replicate-only flip never fires
      // and every single pair would run guard-off first — the within-pair
      // order effect this is here to cancel would land entirely on guard-on.
      // Folding in coupleIndex balances the order across couples even at one
      // replicate, and still flips between replicates for a given couple.
      //
      // This makes arm order share a parity with openerSide below, which is
      // harmless: openerSide is held constant within a pair, so it cancels out
      // of the within-pair delta entirely and cannot correlate with the guard
      // effect being measured.
      const arms: Arm[] =
        (coupleIndex + replicate) % 2 === 0 ? ["guard-off", "guard-on"] : ["guard-on", "guard-off"];
      const openerSide: "a" | "b" = (coupleIndex + replicate) % 2 === 0 ? "a" : "b";
      for (const arm of arms) {
        plan.push({ pairId: pairIds[coupleIndex], coupleIndex, replicate, arm, openerSide });
      }
    }
  }
  return plan;
}

export interface AbOutcome {
  pairId: string;
  replicate: number;
  arm: Arm;
  goldenScore: number;
  scoreA: number;
  scoreB: number;
  matched: boolean;
  // Surviving `staged-qa-exchange` turns in the final transcript. Free to
  // compute (no judge call), and the direct test of whether the re-ask actually
  // reduces contamination — the claim #422 could not settle.
  quietSurvived: number;
}

export interface ArmSummary {
  arm: Arm;
  runs: number;
  decisionsCorrect: number;
  accuracy: number;
  meanCenter: number;
  quietSurvivedTotal: number;
  runsWithQuiet: number;
}

export function summarizeArm(outcomes: AbOutcome[], arm: Arm): ArmSummary {
  const rows = outcomes.filter((o) => o.arm === arm);
  const correct = rows.filter(
    (o) => o.matched === expectedToMatch(categoryForScore(o.goldenScore))
  ).length;
  const centers = rows.map((o) => (o.scoreA + o.scoreB) / 2);
  return {
    arm,
    runs: rows.length,
    decisionsCorrect: correct,
    accuracy: rows.length > 0 ? correct / rows.length : 0,
    meanCenter: centers.length > 0 ? centers.reduce((s, c) => s + c, 0) / centers.length : 0,
    quietSurvivedTotal: rows.reduce((n, o) => n + o.quietSurvived, 0),
    runsWithQuiet: rows.filter((o) => o.quietSurvived > 0).length,
  };
}

export interface CouplePairedDelta {
  pairId: string;
  goldenScore: number;
  pairs: number;
  // guard-on minus guard-off, averaged over replicates. Positive = the guard
  // pushed this couple's score UP.
  centerDelta: number;
  offCorrect: number;
  onCorrect: number;
  offQuiet: number;
  onQuiet: number;
}

// Pairs each replicate's two arms and diffs them WITHIN the pair. Aggregating
// each arm separately and subtracting the means would throw away the pairing —
// the variance this design exists to cancel would come straight back.
export function pairedDeltas(outcomes: AbOutcome[]): CouplePairedDelta[] {
  const byPair = new Map<string, AbOutcome[]>();
  for (const o of outcomes) {
    const list = byPair.get(o.pairId) ?? [];
    list.push(o);
    byPair.set(o.pairId, list);
  }

  const out: CouplePairedDelta[] = [];
  for (const [pairId, rows] of byPair) {
    const replicates = [...new Set(rows.map((r) => r.replicate))].sort((x, y) => x - y);
    const deltas: number[] = [];
    let offCorrect = 0;
    let onCorrect = 0;
    let offQuiet = 0;
    let onQuiet = 0;
    let complete = 0;

    for (const replicate of replicates) {
      const off = rows.find((r) => r.replicate === replicate && r.arm === "guard-off");
      const on = rows.find((r) => r.replicate === replicate && r.arm === "guard-on");
      // A half-finished pair (one arm crashed or was cut short by a rate limit)
      // is dropped rather than compared against the other couple's runs — an
      // unpaired run carries exactly the confound this design removes.
      if (!off || !on) continue;
      complete++;
      deltas.push((on.scoreA + on.scoreB) / 2 - (off.scoreA + off.scoreB) / 2);
      const expected = expectedToMatch(categoryForScore(off.goldenScore));
      if (off.matched === expected) offCorrect++;
      if (on.matched === expected) onCorrect++;
      offQuiet += off.quietSurvived;
      onQuiet += on.quietSurvived;
    }

    out.push({
      pairId,
      goldenScore: rows[0].goldenScore,
      pairs: complete,
      centerDelta: deltas.length > 0 ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 0,
      offCorrect,
      onCorrect,
      offQuiet,
      onQuiet,
    });
  }
  return out;
}

// Sign test over complete pairs — with ~10 couples and few replicates, a t-test
// would be claiming precision the sample can't support. This reports the raw
// direction counts and leaves the reader to judge, which is the honest read at
// this N. `ties` are pairs where the guard changed nothing.
export interface SignTest {
  up: number;
  down: number;
  ties: number;
  total: number;
}

export function signTest(deltas: CouplePairedDelta[]): SignTest {
  const scored = deltas.filter((d) => d.pairs > 0);
  return {
    up: scored.filter((d) => d.centerDelta > 0).length,
    down: scored.filter((d) => d.centerDelta < 0).length,
    ties: scored.filter((d) => d.centerDelta === 0).length,
    total: scored.length,
  };
}
