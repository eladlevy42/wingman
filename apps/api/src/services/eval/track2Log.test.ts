import { describe, it, expect } from "vitest";
import { buildTrack2LogRecord } from "./track2Log";
import { Track2LogRecordSchema } from "@wingman/shared";

describe("buildTrack2LogRecord", () => {
  it("assembles a schema-valid record from negotiation + judge inputs", () => {
    const record = buildTrack2LogRecord({
      pair: { id: "p1", userAId: "a", userBId: "b", goldenScore: 8, category: "compatible" },
      nameA: "Alex",
      nameB: "Sam",
      negotiation: {
        deliberationLog: [{ speaker: "Alex's agent", content: "hi", thinking: "open warm" }],
        scoreA: 8,
        scoreB: 7,
        matched: true,
        rationale: "placeholder",
        rationaleA: "placeholder",
        rationaleB: "placeholder",
        costUsd: 0,
        durationMs: 0,
        guardRetries: [{ speaker: "Alex's agent", kinds: ["staged-qa-exchange"] }],
      },
      groundednessA: [{ claim: "I love hiking", reason: "profile says gaming", kind: "self" }],
      groundednessB: [],
      totalClaims: 5,
      consistency: {
        aDealbreakerViolated: false,
        aConsistent: true,
        bDealbreakerViolated: false,
        bConsistent: true,
        explanation: "ok",
      },
      judgeScore: 8,
      judgeRationale: "aligned",
      deltaA: 0,
      deltaB: -1,
      bandAgreement: true,
      bandAgreementA: true,
      bandAgreementB: true,
    });
    expect(() => Track2LogRecordSchema.parse(record)).not.toThrow();
    expect(record.protocolViolations).toEqual([]);
    expect(record.quietViolations).toEqual([]);
    expect(record.lieFlags.a).toHaveLength(1);
    expect(record.conversation[0].thinking).toBe("open warm");
    expect(record.outcome.matched).toBe(true);
    // Guard re-asks ride through from the negotiation result (#422).
    expect(record.guardRetries).toEqual([
      { speaker: "Alex's agent", kinds: ["staged-qa-exchange"] },
    ]);
    // Per-side band verdicts (#422) land in the outcome next to the mean-based bit.
    expect(record.outcome.bandAgreementA).toBe(true);
    expect(record.outcome.bandAgreementB).toBe(true);
  });

  // A quiet staged exchange is recorded separately from a leaked score.
  it("routes a surviving quiet violation away from the calibration-exclusion flag", () => {
    const base = {
      pair: { id: "p1", userAId: "a", userBId: "b", goldenScore: 8, category: "compatible" },
      nameA: "Alex",
      nameB: "Sam",
      groundednessA: [],
      groundednessB: [],
      totalClaims: 0,
      consistency: null,
      judgeScore: null,
      judgeRationale: null,
      deltaA: 0,
      deltaB: 0,
    };
    const negotiation = (content: string) => ({
      deliberationLog: [{ speaker: "Alex's agent", content }],
      scoreA: 8,
      scoreB: 7,
      matched: true,
      rationale: null,
      rationaleA: null,
      rationaleB: null,
      costUsd: 0,
      durationMs: 0,
      guardRetries: [],
    });

    // A staged Q&A exchange that survived the retry: annotated, not condemned.
    const quiet = buildTrack2LogRecord({
      ...base,
      negotiation: negotiation(
        "First question about the profile?\n\n" +
          "A synthetic answer that is long enough to count.\n\n" +
          "Second question about the profile?"
      ),
    });
    expect(quiet.protocolViolations).toEqual([]);
    expect(quiet.quietViolations).toHaveLength(1);
    expect(quiet.quietViolations[0].kinds).toEqual(["staged-qa-exchange"]);

    // A leaked score still condemns the transcript, exactly as before #422.
    const loud = buildTrack2LogRecord({
      ...base,
      negotiation: negotiation("My score is 8 for this match."),
    });
    expect(loud.protocolViolations).toHaveLength(1);
    expect(loud.protocolViolations[0].kinds).toEqual(["score-statement"]);
    expect(loud.quietViolations).toEqual([]);
  });
});
