import { describe, expect, it } from "vitest";
import type { EvalRunDetail } from "@wingman/shared";
import { rowsForRun, runToCsv, runToJson } from "./export";

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function baseRun(overrides: Partial<EvalRunDetail> = {}): EvalRunDetail {
  return {
    id: uuid(1),
    track: 1,
    status: "completed",
    config: { barneyModel: "sonnet", judgeModel: "sonnet" },
    costUsd: 0,
    durationMs: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null,
    ...overrides,
  };
}

describe("rowsForRun", () => {
  it("returns an empty array when the run has no result yet", () => {
    expect(rowsForRun(baseRun())).toEqual([]);
  });

  it("flattens track 1 into one row per user", () => {
    const run = baseRun({
      track: 1,
      result: {
        meanPrecision: 0.5,
        perUser: [
          {
            userId: uuid(2),
            actual: [uuid(3)],
            expected: [uuid(3), uuid(4)],
            precision: 0.5,
            costUsd: 0,
            durationMs: 12,
          },
        ],
      },
    });

    expect(rowsForRun(run)).toEqual([
      {
        userId: uuid(2),
        precision: 0.5,
        expectedCount: 2,
        actualCount: 1,
        costUsd: 0,
        durationMs: 12,
      },
    ]);
  });

  it("flattens track 2 into one row per pair, omitting the transcript", () => {
    const run = baseRun({
      track: 2,
      result: [
        {
          pairId: uuid(2),
          goldenScore: 8,
          scoreA: 9,
          scoreB: 7,
          deltaA: 1,
          deltaB: -1,
          matched: true,
          judgeScore: 8,
          judgeRationale: "good fit",
          dealbreakerConsistency: null,
          groundedness: null,
          transcript: "a very long transcript",
          costUsd: 0.02,
          durationMs: 500,
        },
      ],
    });

    const rows = rowsForRun(run);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("transcript");
    expect(rows[0]).toMatchObject({ pairId: uuid(2), scoreA: 9, scoreB: 7, judgeScore: 8 });
  });

  it("flattens track 3 into one row per transcript", () => {
    const run = baseRun({
      track: 3,
      result: [
        {
          userId: uuid(2),
          transcriptId: uuid(3),
          fields: [],
          matchCount: 4,
          fieldCount: 5,
          costUsd: 0.003,
          durationMs: 400,
        },
      ],
    });

    expect(rowsForRun(run)).toEqual([
      {
        userId: uuid(2),
        transcriptId: uuid(3),
        matchCount: 4,
        fieldCount: 5,
        costUsd: 0.003,
        durationMs: 400,
      },
    ]);
  });
});

describe("runToCsv", () => {
  it("returns an empty string for a run with no cases", () => {
    expect(runToCsv(baseRun())).toBe("");
  });

  it("produces a header row plus one row per case", () => {
    const run = baseRun({
      track: 1,
      result: {
        meanPrecision: 1,
        perUser: [
          { userId: uuid(2), actual: [], expected: [], precision: 1, costUsd: 0, durationMs: 5 },
        ],
      },
    });

    const csv = runToCsv(run);
    const [header, row] = csv.split("\n");
    expect(header).toBe("userId,precision,expectedCount,actualCount,costUsd,durationMs");
    expect(row).toBe(`${uuid(2)},1,0,0,0,5`);
  });

  it("quotes a cell whose value contains a comma", () => {
    const run = baseRun({
      track: 1,
      result: {
        meanPrecision: 1,
        // pairId/userId are typed as uuid strings but rowsForRun/toCsvCell
        // don't validate — any string exercises the CSV-quoting path.
        perUser: [
          {
            userId: "user, with comma",
            actual: [],
            expected: [],
            precision: 1,
            costUsd: 0,
            durationMs: 5,
          },
        ],
      },
    });

    const [, row] = runToCsv(run).split("\n");
    expect(row).toBe('"user, with comma",1,0,0,0,5');
  });
});

describe("runToJson", () => {
  it("round-trips the full run, including the transcript", () => {
    const run = baseRun({
      track: 2,
      result: [
        {
          pairId: uuid(2),
          goldenScore: 8,
          scoreA: 9,
          scoreB: 7,
          deltaA: 1,
          deltaB: -1,
          matched: true,
          judgeScore: 8,
          judgeRationale: "good fit",
          dealbreakerConsistency: null,
          groundedness: null,
          transcript: "the full transcript",
          costUsd: 0.02,
          durationMs: 500,
        },
      ],
    });

    const parsed = JSON.parse(runToJson(run));
    expect(parsed.result[0].transcript).toBe("the full transcript");
  });
});
