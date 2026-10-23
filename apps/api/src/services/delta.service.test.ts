import { describe, it, expect, vi, beforeEach } from "vitest";
import { mergeDeltas } from "./delta.service";

vi.mock("@wingman/database", () => ({
  prisma: {
    feedbackRound: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@wingman/database";

beforeEach(() => {
  vi.clearAllMocks();
});

function round(delta: object, createdAt = new Date()) {
  return {
    id: "round-id",
    userId: "user-id",
    matchId: "match-id",
    rawTranscript: "",
    delta: JSON.stringify(delta),
    createdAt,
  };
}

describe("mergeDeltas", () => {
  it("deduplicates addedDealbreakers across rounds", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: ["smoking"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
      round({
        addedDealbreakers: ["smoking", "drinking"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.addedDealbreakers).toEqual(["smoking", "drinking"]);
  });

  it("subtracts removedPreferences from accumulated addedPreferences", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: ["hiking", "reading"],
        compromiseUpdates: [],
      }),
      round({
        addedDealbreakers: [],
        removedPreferences: ["hiking"],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.addedPreferences).toEqual(["reading"]);
    expect(result.removedPreferences).toEqual(["hiking"]);
  });

  it("returns empty delta for an empty FeedbackRound list", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([]);

    const result = await mergeDeltas("user-id");

    expect(result).toEqual({
      addedDealbreakers: [],
      removedDealbreakers: [],
      removedPreferences: [],
      addedPreferences: [],
      compromiseUpdates: [],
    });
  });

  // Issue #341: compromiseUpdates reflects the human's current stance, not an
  // accumulating log — a later round's statement replaces an earlier,
  // possibly-conflicting one instead of both surviving side by side.
  it("lets a later round's compromiseUpdates supersede an earlier, conflicting round's", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: ["open to weekday dates"],
      }),
      round({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: ["not open to weekday dates anymore"],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.compromiseUpdates).toEqual(["not open to weekday dates anymore"]);
  });

  it("keeps the last non-empty round's compromiseUpdates when a later round reports none", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: ["open to longer commute"],
      }),
      round({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    // The empty round didn't mention compromises at all — it shouldn't wipe
    // the stance the prior round established.
    expect(result.compromiseUpdates).toEqual(["open to longer commute"]);
  });

  // Issue #341: a mistakenly-added (or since-resolved) dealbreaker can be
  // retracted by a later round, mirroring removedPreferences' existing shape.
  it("subtracts removedDealbreakers from accumulated addedDealbreakers", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: ["lateness", "smoking"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
      round({
        addedDealbreakers: [],
        removedDealbreakers: ["lateness"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.addedDealbreakers).toEqual(["smoking"]);
    expect(result.removedDealbreakers).toEqual(["lateness"]);
  });

  // A FeedbackRound persisted before #341 has no removedDealbreakers key at
  // all — the schema default must let it still parse.
  it("parses a pre-#341 round with no removedDealbreakers key", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: ["smoking"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.addedDealbreakers).toEqual(["smoking"]);
    expect(result.removedDealbreakers).toEqual([]);
  });

  // Issue #355: the core bug — an older removal must not permanently beat a
  // newer re-add. Resolved last-write-wins per term, by round order.
  it("lets a later round's re-add of a preference override an earlier round's removal", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: ["ambitious"],
        compromiseUpdates: [],
      }),
      round({
        addedDealbreakers: [],
        removedPreferences: ["ambitious"],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
      round({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: ["ambitious"],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.addedPreferences).toEqual(["ambitious"]);
    expect(result.removedPreferences).toEqual([]);
  });

  it("lets a later round's removal of a dealbreaker override an earlier round's re-add", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: [],
        removedDealbreakers: ["smoking"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
      round({
        addedDealbreakers: ["smoking"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
      round({
        addedDealbreakers: [],
        removedDealbreakers: ["smoking"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.addedDealbreakers).toEqual([]);
    expect(result.removedDealbreakers).toEqual(["smoking"]);
  });

  // Still holds: add-then-remove (no re-add after) ends removed — the
  // existing behavior the fix must not disturb.
  it("still ends removed when a later round removes a preference added earlier, with no re-add after", async () => {
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: ["hiking"],
        compromiseUpdates: [],
      }),
      round({
        addedDealbreakers: [],
        removedPreferences: ["hiking"],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.addedPreferences).toEqual([]);
    expect(result.removedPreferences).toEqual(["hiking"]);
  });

  // Issue #355: one round's corrupt delta JSON must not take down the whole
  // merge — the remaining rounds still combine, with a warning logged instead
  // of throwing.
  it("skips a round with malformed delta JSON and still merges the rest", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(prisma.feedbackRound.findMany).mockResolvedValue([
      round({
        addedDealbreakers: ["smoking"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
      { ...round({}), delta: "{not valid json" },
      round({
        addedDealbreakers: ["lateness"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      }),
    ]);

    const result = await mergeDeltas("user-id");

    expect(result.addedDealbreakers).toEqual(["smoking", "lateness"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping malformed FeedbackRound"),
      expect.anything()
    );
    warnSpy.mockRestore();
  });
});
