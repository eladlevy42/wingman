import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    evalRun: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("./track1.service", () => ({ runTrack1: vi.fn() }));
vi.mock("./track2.service", () => ({ runTrack2: vi.fn() }));
vi.mock("./track3.service", () => ({ runTrack3: vi.fn() }));
// Real writeTrack2Log does filesystem I/O (issue #420) — mocked so the test
// suite never leaves stray JSON files under docs/evidence/.
vi.mock("./track2Log", () => ({ writeTrack2Log: vi.fn().mockResolvedValue("/fake/path.json") }));

import { prisma } from "@wingman/database";
import { runTrack1 } from "./track1.service";
import { runTrack2 } from "./track2.service";
import { runTrack3 } from "./track3.service";
import { writeTrack2Log } from "./track2Log";
import { startEvalRun, listEvalRuns, getEvalRun, EvalRunNotFoundError } from "./evalRun.service";

// Flushes pending microtasks so the fire-and-forget background work inside
// startEvalRun (a `void (async () => {...})()`) has a chance to run before
// assertions — see evalRun.service.ts.
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const baseRow = {
  id: "00000000-0000-0000-0000-000000000001",
  track: 1,
  status: "running",
  config: "{}",
  result: null,
  costUsd: 0,
  durationMs: 0,
  error: null,
  createdAt: new Date("2026-07-09T00:00:00.000Z"),
  updatedAt: new Date("2026-07-09T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.evalRun.create).mockResolvedValue(baseRow as never);
  vi.mocked(prisma.evalRun.update).mockResolvedValue({
    ...baseRow,
    status: "completed",
    result: "{}",
  } as never);
});

describe("startEvalRun", () => {
  it("creates a running row immediately and routes track 1 to runTrack1", async () => {
    vi.mocked(runTrack1).mockResolvedValue({ meanPrecision: 0.8, perUser: [] });

    const summary = await startEvalRun(1);

    expect(summary.status).toBe("running");
    expect(prisma.evalRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ track: 1, status: "running" }) })
    );

    await flush();
    expect(runTrack1).toHaveBeenCalledOnce();
    expect(runTrack2).not.toHaveBeenCalled();
    expect(prisma.evalRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "00000000-0000-0000-0000-000000000001" },
        data: expect.objectContaining({ status: "completed" }),
      })
    );
  });

  it("routes track 2 to runTrack2 and track 3 to runTrack3", async () => {
    vi.mocked(runTrack2).mockResolvedValue({ result: [], logRecords: [] });
    await startEvalRun(2);
    await flush();
    expect(runTrack2).toHaveBeenCalledOnce();

    vi.mocked(runTrack3).mockResolvedValue([]);
    await startEvalRun(3);
    await flush();
    expect(runTrack3).toHaveBeenCalledOnce();
  });

  it("flushes each Track 2 record incrementally and still writes the log on a stopped run", async () => {
    // Issue #420: the app path must give Track 2 the same crash-safety the CLI
    // has — flush per couple, and persist the log even when the run stops early.
    const fakeRecord = {
      couple: { pairId: "p1" },
      guardRetries: [{ speaker: "A's agent", kinds: ["score-statement"] }],
    } as never;
    // Valid (empty) Track 2 result so the final toDetail() parse succeeds —
    // otherwise the emit path would throw into the catch and write a 3rd time.
    vi.mocked(prisma.evalRun.update).mockResolvedValue({
      ...baseRow,
      track: 2,
      status: "stopped",
      result: "[]",
    } as never);
    vi.mocked(runTrack2).mockImplementation(async (ctx) => {
      await ctx.onRecord?.(fakeRecord); // per-couple flush (partial write)
      // A case cost past the budget cap flips the run to "stopped".
      ctx.onCase({ index: 1, total: 2, costUsd: 100, durationMs: 1, score: 0.5, summary: "x" });
      return { result: [], logRecords: [] };
    });

    await startEvalRun(2, { budgetCapUsd: 1 });
    await flush();

    // Written at least twice: the incremental partial + the final write.
    expect(writeTrack2Log).toHaveBeenCalledTimes(2);
    // The run ended "stopped", yet the evidence was still persisted.
    expect(prisma.evalRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "stopped" }) })
    );
    // The final write hoists the guard's re-ask total into meta (issue #422).
    const finalLog = vi.mocked(writeTrack2Log).mock.calls.at(-1)?.[0];
    expect(finalLog?.meta.guardRetryCount).toBe(1);
  });

  it("preserves the Track 2 log when the run crashes mid-way", async () => {
    const fakeRecord = { couple: { pairId: "p1" }, guardRetries: [] } as never;
    vi.mocked(runTrack2).mockImplementation(async (ctx) => {
      await ctx.onRecord?.(fakeRecord);
      throw new Error("rate limit");
    });

    await startEvalRun(2);
    await flush();

    // Record flushed before the crash + a refresh in the catch block.
    expect(writeTrack2Log).toHaveBeenCalled();
    expect(prisma.evalRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) })
    );
  });

  it("does not write a Track 2 log when no couples completed", async () => {
    vi.mocked(runTrack2).mockResolvedValue({ result: [], logRecords: [] });

    await startEvalRun(2);
    await flush();

    expect(writeTrack2Log).not.toHaveBeenCalled();
  });

  it("marks the run failed when the track runner throws", async () => {
    vi.mocked(runTrack1).mockRejectedValue(new Error("boom"));

    await startEvalRun(1);
    await flush();

    expect(prisma.evalRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", error: "boom" }),
      })
    );
  });

  it("passes a resolved config (with model defaults applied) to the runner", async () => {
    vi.mocked(runTrack1).mockResolvedValue({ meanPrecision: 0, perUser: [] });

    await startEvalRun(1, { count: 10 });
    await flush();

    const ctx = vi.mocked(runTrack1).mock.calls[0][0];
    expect(ctx.config).toEqual(
      expect.objectContaining({ count: 10, barneyModel: "sonnet", judgeModel: "sonnet" })
    );
  });
});

describe("listEvalRuns", () => {
  it("returns parsed summaries, optionally filtered by track", async () => {
    vi.mocked(prisma.evalRun.findMany).mockResolvedValue([
      { ...baseRow, status: "completed", result: "{}" },
    ] as never);

    const runs = await listEvalRuns(1, 10);

    expect(prisma.evalRun.findMany).toHaveBeenCalledWith({
      where: { track: 1 },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("00000000-0000-0000-0000-000000000001");
  });
});

describe("getEvalRun", () => {
  it("returns the parsed run detail", async () => {
    vi.mocked(prisma.evalRun.findUnique).mockResolvedValue({
      ...baseRow,
      status: "completed",
      result: JSON.stringify({ meanPrecision: 1, perUser: [] }),
    } as never);

    const run = await getEvalRun("00000000-0000-0000-0000-000000000001");

    expect(run.result).toEqual({ meanPrecision: 1, perUser: [] });
  });

  it("throws EvalRunNotFoundError when the run does not exist", async () => {
    vi.mocked(prisma.evalRun.findUnique).mockResolvedValue(null as never);

    await expect(getEvalRun("missing")).rejects.toThrow(EvalRunNotFoundError);
  });
});
