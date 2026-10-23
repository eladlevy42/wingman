import { describe, expect, it } from "vitest";
import { buildAbPlan, summarizeArm, pairedDeltas, signTest, type AbOutcome } from "./abPairing";

describe("buildAbPlan", () => {
  it("emits both arms adjacently so a pair runs back-to-back", () => {
    const plan = buildAbPlan(["p1", "p2"], 1);

    expect(plan).toHaveLength(4);
    // p1's two arms are adjacent, then p2's — adjacency is what controls drift.
    expect(plan.map((s) => `${s.pairId}:${s.arm}`)).toEqual([
      "p1:guard-off",
      "p1:guard-on",
      "p2:guard-on",
      "p2:guard-off",
    ]);
  });

  it("alternates arm order across couples at the default 1 replicate", () => {
    // The harness's default is EVAL_AB_REPLICATES=1, so a replicate-only flip
    // would never fire and every pair would run guard-off first — handing any
    // within-pair second-run advantage entirely to guard-on.
    const plan = buildAbPlan(["p1", "p2", "p3", "p4"], 1);
    const firstArms = plan.filter((_, i) => i % 2 === 0).map((s) => s.arm);

    expect(firstArms).toEqual(["guard-off", "guard-on", "guard-off", "guard-on"]);
    expect(firstArms.filter((a) => a === "guard-off")).toHaveLength(2);
    expect(firstArms.filter((a) => a === "guard-on")).toHaveLength(2);
  });

  it("holds openerSide constant WITHIN a pair — the guard must be the only difference", () => {
    const plan = buildAbPlan(["p1", "p2", "p3"], 2);

    for (let i = 0; i < plan.length; i += 2) {
      expect(plan[i].pairId).toBe(plan[i + 1].pairId);
      expect(plan[i].replicate).toBe(plan[i + 1].replicate);
      expect(plan[i].openerSide).toBe(plan[i + 1].openerSide);
      expect(plan[i].arm).not.toBe(plan[i + 1].arm);
    }
  });

  it("also alternates arm order between replicates of the same couple", () => {
    const plan = buildAbPlan(["p1"], 2);

    expect(plan.filter((s) => s.replicate === 0).map((s) => s.arm)).toEqual([
      "guard-off",
      "guard-on",
    ]);
    expect(plan.filter((s) => s.replicate === 1).map((s) => s.arm)).toEqual([
      "guard-on",
      "guard-off",
    ]);
  });

  it("varies openerSide across couples and replicates so first-mover bias sits on neither arm", () => {
    const plan = buildAbPlan(["p1", "p2"], 2);
    const sides = plan
      .filter((_, i) => i % 2 === 0)
      .map((s) => `${s.pairId}r${s.replicate}=${s.openerSide}`);

    // (coupleIndex + replicate) % 2 — so a couple isn't always the same opener.
    expect(sides).toEqual(["p1r0=a", "p1r1=b", "p2r0=b", "p2r1=a"]);
  });

  it("returns an empty plan for no couples", () => {
    expect(buildAbPlan([], 3)).toEqual([]);
  });
});

// goldenScore 8 -> compatible -> expected to match; 2 -> incompatible -> not.
function outcome(over: Partial<AbOutcome> = {}): AbOutcome {
  return {
    pairId: "p1",
    replicate: 0,
    arm: "guard-off",
    goldenScore: 8,
    scoreA: 8,
    scoreB: 8,
    matched: true,
    quietSurvived: 0,
    ...over,
  };
}

describe("summarizeArm", () => {
  it("scores each arm against the golden category's expected match decision", () => {
    const outcomes = [
      outcome({ arm: "guard-off", scoreA: 8, scoreB: 8, matched: true }),
      outcome({ arm: "guard-off", goldenScore: 2, scoreA: 2, scoreB: 2, matched: false }),
      // guard-on turns the incompatible couple into a false positive.
      outcome({ arm: "guard-on", scoreA: 8, scoreB: 8, matched: true }),
      outcome({ arm: "guard-on", goldenScore: 2, scoreA: 7, scoreB: 7, matched: true }),
    ];

    const off = summarizeArm(outcomes, "guard-off");
    const on = summarizeArm(outcomes, "guard-on");

    expect(off.decisionsCorrect).toBe(2);
    expect(off.accuracy).toBe(1);
    expect(on.decisionsCorrect).toBe(1);
    expect(on.accuracy).toBe(0.5);
    expect(off.meanCenter).toBe(5);
    expect(on.meanCenter).toBe(7.5);
  });

  it("counts quiet survivors both in total and by affected run", () => {
    const outcomes = [
      outcome({ arm: "guard-on", quietSurvived: 3 }),
      outcome({ arm: "guard-on", replicate: 1, quietSurvived: 0 }),
      outcome({ arm: "guard-on", replicate: 2, quietSurvived: 2 }),
    ];

    const on = summarizeArm(outcomes, "guard-on");

    expect(on.quietSurvivedTotal).toBe(5);
    expect(on.runsWithQuiet).toBe(2);
    expect(on.runs).toBe(3);
  });

  it("reports zeroes rather than NaN when an arm has no runs", () => {
    const on = summarizeArm([outcome({ arm: "guard-off" })], "guard-on");

    expect(on.runs).toBe(0);
    expect(on.accuracy).toBe(0);
    expect(on.meanCenter).toBe(0);
  });
});

describe("pairedDeltas", () => {
  it("diffs within a replicate rather than across arm means", () => {
    const outcomes = [
      outcome({ replicate: 0, arm: "guard-off", scoreA: 8, scoreB: 8 }),
      outcome({ replicate: 0, arm: "guard-on", scoreA: 6, scoreB: 6 }),
      outcome({ replicate: 1, arm: "guard-off", scoreA: 4, scoreB: 4 }),
      outcome({ replicate: 1, arm: "guard-on", scoreA: 5, scoreB: 5 }),
    ];

    const [d] = pairedDeltas(outcomes);

    // Per-replicate deltas are -2 and +1, so the mean is -0.5. Differencing the
    // arm means (6.0 - 5.5) would give +0.5 — the opposite sign.
    expect(d.centerDelta).toBe(-0.5);
    expect(d.pairs).toBe(2);
  });

  it("drops a half-finished pair instead of comparing an unpaired run", () => {
    const outcomes = [
      outcome({ replicate: 0, arm: "guard-off", scoreA: 8, scoreB: 8 }),
      outcome({ replicate: 0, arm: "guard-on", scoreA: 7, scoreB: 7 }),
      // replicate 1 crashed mid-pair — guard-on never ran.
      outcome({ replicate: 1, arm: "guard-off", scoreA: 2, scoreB: 2 }),
    ];

    const [d] = pairedDeltas(outcomes);

    expect(d.pairs).toBe(1);
    expect(d.centerDelta).toBe(-1);
  });

  it("tracks match correctness and quiet survivors per arm within the couple", () => {
    const outcomes = [
      outcome({ arm: "guard-off", matched: true, quietSurvived: 4 }),
      outcome({ arm: "guard-on", matched: false, quietSurvived: 1 }),
    ];

    const [d] = pairedDeltas(outcomes);

    expect(d.offCorrect).toBe(1);
    expect(d.onCorrect).toBe(0);
    expect(d.offQuiet).toBe(4);
    expect(d.onQuiet).toBe(1);
  });

  it("keeps couples separate", () => {
    const outcomes = [
      outcome({ pairId: "p1", arm: "guard-off", scoreA: 8, scoreB: 8 }),
      outcome({ pairId: "p1", arm: "guard-on", scoreA: 8, scoreB: 8 }),
      outcome({ pairId: "p2", arm: "guard-off", scoreA: 8, scoreB: 8 }),
      outcome({ pairId: "p2", arm: "guard-on", scoreA: 4, scoreB: 4 }),
    ];

    const deltas = pairedDeltas(outcomes);

    expect(deltas).toHaveLength(2);
    expect(deltas.find((d) => d.pairId === "p1")?.centerDelta).toBe(0);
    expect(deltas.find((d) => d.pairId === "p2")?.centerDelta).toBe(-4);
  });
});

describe("signTest", () => {
  it("counts direction of the paired deltas and separates ties", () => {
    const result = signTest([
      {
        pairId: "a",
        goldenScore: 8,
        pairs: 1,
        centerDelta: -2,
        offCorrect: 1,
        onCorrect: 0,
        offQuiet: 0,
        onQuiet: 0,
      },
      {
        pairId: "b",
        goldenScore: 8,
        pairs: 1,
        centerDelta: 1.5,
        offCorrect: 1,
        onCorrect: 1,
        offQuiet: 0,
        onQuiet: 0,
      },
      {
        pairId: "c",
        goldenScore: 2,
        pairs: 1,
        centerDelta: 0,
        offCorrect: 1,
        onCorrect: 1,
        offQuiet: 0,
        onQuiet: 0,
      },
    ]);

    expect(result).toEqual({ up: 1, down: 1, ties: 1, total: 3 });
  });

  it("excludes couples with no complete pair from the denominator", () => {
    const result = signTest([
      {
        pairId: "a",
        goldenScore: 8,
        pairs: 0,
        centerDelta: 0,
        offCorrect: 0,
        onCorrect: 0,
        offQuiet: 0,
        onQuiet: 0,
      },
      {
        pairId: "b",
        goldenScore: 8,
        pairs: 2,
        centerDelta: -1,
        offCorrect: 2,
        onCorrect: 1,
        offQuiet: 0,
        onQuiet: 0,
      },
    ]);

    expect(result.total).toBe(1);
    expect(result.down).toBe(1);
  });
});
