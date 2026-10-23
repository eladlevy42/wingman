import { describe, expect, it, vi, beforeEach } from "vitest";
import { EvalRunConfigSchema } from "@wingman/shared";
import type { EvalRunContext } from "./types";
import { runTrack1, EvalPreconditionError } from "./track1.service";

vi.mock("@wingman/database", () => ({
  prisma: {
    user: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
  EXPECTED_MATCHES_PER_USER: 5,
}));

vi.mock("../matching.service", () => ({
  deterministicFilter: vi.fn(),
}));

import { prisma } from "@wingman/database";
import { deterministicFilter } from "../matching.service";

// zod's uuid() only checks the 8-4-4-4-12 hex shape, not RFC version/variant
// nibbles, so plain hex-padded ids are valid without pulling in a uuid lib.
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function makeCtx(overrides: Partial<EvalRunContext> = {}): EvalRunContext {
  return {
    config: EvalRunConfigSchema.parse({}),
    shouldStop: () => false,
    onCase: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runTrack1", () => {
  it("throws EvalPreconditionError when WAITING user count is not 500", async () => {
    vi.mocked(prisma.user.count).mockResolvedValue(42);

    await expect(runTrack1(makeCtx())).rejects.toThrow(EvalPreconditionError);
    await expect(runTrack1(makeCtx())).rejects.toThrow("500");
  });

  it("scopes the precondition count to seeded WAITING users with expectedMatches, excluding pinned fixtures (#411)", async () => {
    // A normal `pnpm db:seed` run leaves 502 raw WAITING users (500 archetype
    // + 2 pinned synthetic fixtures), but only the 500 archetype users
    // carry expectedMatches — the precondition must scope to those, not the
    // raw WAITING total.
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);

    await expect(runTrack1(makeCtx())).resolves.toBeTruthy();
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { matchingState: "WAITING", expectedMatches: { not: null } },
    });
  });

  it("still fails a genuinely under-seeded database (e.g. the E2E harness with no seeding at all)", async () => {
    vi.mocked(prisma.user.count).mockResolvedValue(3);

    await expect(runTrack1(makeCtx())).rejects.toThrow(EvalPreconditionError);
    await expect(runTrack1(makeCtx())).rejects.toThrow("found 3");
  });

  it("computes precision correctly for a single user with 3 of 5 hits", async () => {
    const [user1, a, b, c, d, e, x, y] = [1, 2, 3, 4, 5, 6, 7, 8].map(uuid);
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      {
        id: user1,
        expectedMatches: JSON.stringify([a, b, c, d, e]),
      },
    ] as never);
    // actual overlaps on a, b, c — 3 hits out of 5 expected
    vi.mocked(deterministicFilter).mockResolvedValue([a, b, c, x, y]);

    const result = await runTrack1(makeCtx());

    expect(result.perUser).toHaveLength(1);
    expect(result.perUser[0].precision).toBe(0.6);
    expect(result.meanPrecision).toBe(0.6);
  });

  it("computes mean precision correctly across multiple users", async () => {
    const [u1, u2, u3, a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, x, y, z] = Array.from(
      { length: 21 },
      (_, idx) => uuid(idx + 1)
    );
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: u1, expectedMatches: JSON.stringify([a, b, c, d, e]) },
      { id: u2, expectedMatches: JSON.stringify([f, g, h, i, j]) },
      { id: u3, expectedMatches: JSON.stringify([k, l, m, n, o]) },
    ] as never);
    vi.mocked(deterministicFilter)
      .mockResolvedValueOnce([a, b, c, d, e]) // 5/5 = 1.0
      .mockResolvedValueOnce([f, g, x, y, z]) // 2/5 = 0.4
      .mockResolvedValueOnce([k, l, m, n, o]); // 5/5 = 1.0

    const result = await runTrack1(makeCtx());

    expect(result.meanPrecision).toBeCloseTo((1.0 + 0.4 + 1.0) / 3);
    expect(result.perUser[0].precision).toBe(1.0);
    expect(result.perUser[1].precision).toBe(0.4);
    expect(result.perUser[2].precision).toBe(1.0);
  });

  it("returns precision 0 when deterministicFilter returns no matches from expected", async () => {
    const [u1, a, b, c, d, e, v, w, x, y, z] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(uuid);
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: u1, expectedMatches: JSON.stringify([a, b, c, d, e]) },
    ] as never);
    vi.mocked(deterministicFilter).mockResolvedValue([v, w, x, y, z]);

    const result = await runTrack1(makeCtx());

    expect(result.perUser[0].precision).toBe(0);
    expect(result.meanPrecision).toBe(0);
  });

  it("includes both actual and expected arrays in per-user results", async () => {
    const [u1, a, b, c, d, e, x, y, z] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(uuid);
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    const expected = [a, b, c, d, e];
    const actual = [a, b, x, y, z];
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: u1, expectedMatches: JSON.stringify(expected) },
    ] as never);
    vi.mocked(deterministicFilter).mockResolvedValue(actual);

    const result = await runTrack1(makeCtx());

    expect(result.perUser[0].expected).toEqual(expected);
    expect(result.perUser[0].actual).toEqual(actual);
    expect(result.perUser[0].userId).toBe(u1);
  });

  it("returns meanPrecision 0 when there are no users with expectedMatches", async () => {
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);

    const result = await runTrack1(makeCtx());

    expect(result.meanPrecision).toBe(0);
    expect(result.perUser).toHaveLength(0);
  });

  it("stops early when the context signals shouldStop", async () => {
    const [u1, u2, a, b, c, d, e] = [1, 2, 3, 4, 5, 6, 7].map(uuid);
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: u1, expectedMatches: JSON.stringify([a, b, c, d, e]) },
      { id: u2, expectedMatches: JSON.stringify([a, b, c, d, e]) },
    ] as never);
    vi.mocked(deterministicFilter).mockResolvedValue([a, b, c, d, e]);

    const result = await runTrack1(makeCtx({ shouldStop: () => true }));

    expect(result.perUser).toHaveLength(0);
    expect(deterministicFilter).not.toHaveBeenCalled();
  });

  it("caps the run at config.count via a seeded sample", async () => {
    const users = Array.from({ length: 10 }, (_, idx) => ({
      id: uuid(idx + 1),
      expectedMatches: JSON.stringify([uuid(100 + idx)]),
    }));
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    vi.mocked(prisma.user.findMany).mockResolvedValue(users as never);
    vi.mocked(deterministicFilter).mockResolvedValue([]);

    const ctx = makeCtx({ config: EvalRunConfigSchema.parse({ count: 3, seed: 42 }) });
    const result = await runTrack1(ctx);

    expect(result.perUser).toHaveLength(3);
    expect(deterministicFilter).toHaveBeenCalledTimes(3);
  });

  it("reports per-case progress via onCase", async () => {
    const [u1, a] = [1, 2].map(uuid);
    vi.mocked(prisma.user.count).mockResolvedValue(500);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: u1, expectedMatches: JSON.stringify([a]) },
    ] as never);
    vi.mocked(deterministicFilter).mockResolvedValue([a]);

    const onCase = vi.fn();
    await runTrack1(makeCtx({ onCase }));

    expect(onCase).toHaveBeenCalledTimes(1);
    expect(onCase).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, total: 1, costUsd: 0 })
    );
  });
});
