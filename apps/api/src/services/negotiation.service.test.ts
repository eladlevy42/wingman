import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NegotiationResult } from "@wingman/shared";

vi.mock("@wingman/database", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../agents/negotiation.agent", () => ({
  runNegotiation: vi.fn(),
  writeFallbackRationale: vi.fn(),
}));

vi.mock("./match.service", () => ({
  createMatch: vi.fn(),
}));

// Issue #299: loadParticipant merges debrief feedback via delta.service.
// Mocked so these tests stay pure loadParticipant/negotiate wiring tests —
// mergeDeltas' own merge semantics are covered by delta.service.test.ts.
vi.mock("./delta.service", () => ({
  mergeDeltas: vi.fn(),
}));

import { prisma } from "@wingman/database";
import { runNegotiation, writeFallbackRationale } from "../agents/negotiation.agent";
import { createMatch } from "./match.service";
import { mergeDeltas } from "./delta.service";
import { negotiateAndPersist, forceMatchAndPersist } from "./negotiation.service";

const EMPTY_DELTA = {
  addedDealbreakers: [],
  removedDealbreakers: [],
  removedPreferences: [],
  addedPreferences: [],
  compromiseUpdates: [],
};

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "user-a",
    name: "Alex",
    profile: {
      structuredData: JSON.stringify({
        age: 28,
        city: "Tel Aviv",
        country: "Israel",
        height: null,
        job: null,
        hometown: null,
        body_type: null,
        conflict_style: null,
        emotional_openness: null,
        treatment_of_others: null,
        personality_traits: [],
        wants_kids: null,
        kids_timeline: null,
        faith: null,
        current_motivation: null,
        life_vision: null,
        hobbies: [],
        typical_weekend: null,
        social_energy: null,
        social_circle: null,
      }),
    },
    wantedProfile: {
      structuredData: JSON.stringify({
        genderPreference: "male",
        ageRange: { min: 25, max: 35 },
        maxDistanceKm: 100,
        appearance: [],
        personality: [],
        lifestyle: [],
        dealbreakers: [],
        preferences: [],
        compromises: [],
      }),
    },
    ...overrides,
  };
}

function makeResult(overrides: Partial<NegotiationResult> = {}): NegotiationResult {
  return {
    deliberationLog: [{ speaker: "Alex's agent", content: "hi" }],
    scoreA: 8,
    scoreB: 8,
    matched: true,
    rationale: "Great match.",
    rationaleA: null,
    rationaleB: null,
    costUsd: 0,
    durationMs: 0,
    guardRetries: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mergeDeltas).mockResolvedValue(EMPTY_DELTA);
});

describe("negotiateAndPersist", () => {
  it("loads both users, runs negotiation, and persists the result", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(makeUser({ id: "user-a", name: "Alex" }) as never)
      .mockResolvedValueOnce(makeUser({ id: "user-b", name: "Blake" }) as never);
    const result = makeResult();
    vi.mocked(runNegotiation).mockResolvedValue(result);
    vi.mocked(createMatch).mockResolvedValue({ id: "match-1", status: "MATCHED" } as never);

    const match = await negotiateAndPersist("user-a", "user-b");

    expect(runNegotiation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a", name: "Alex" }),
      expect.objectContaining({ userId: "user-b", name: "Blake" }),
      undefined
    );
    // #345: a genuine negotiation persists without a matchType argument, so
    // createMatch's default ("NEGOTIATED") applies — the pairing is never
    // mislabeled FORCED.
    expect(createMatch).toHaveBeenCalledWith("user-a", "user-b", result);
    expect(vi.mocked(createMatch).mock.calls[0]).toHaveLength(3);
    expect(match).toEqual({ id: "match-1", status: "MATCHED" });
  });

  // Issue #299: debrief feedback is merged on the production negotiation path
  // and attached to each participant, so the agents' briefings carry the
  // human's most current dealbreakers/preferences.
  it("merges each user's feedback deltas and passes them to the negotiation", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(makeUser({ id: "user-a", name: "Alex" }) as never)
      .mockResolvedValueOnce(makeUser({ id: "user-b", name: "Blake" }) as never);
    const feedbackA = {
      addedDealbreakers: ["smoking"],
      removedDealbreakers: [],
      removedPreferences: [],
      addedPreferences: ["dog person"],
      compromiseUpdates: [],
    };
    vi.mocked(mergeDeltas).mockImplementation(async (userId: string) =>
      userId === "user-a" ? feedbackA : EMPTY_DELTA
    );
    vi.mocked(runNegotiation).mockResolvedValue(makeResult());
    vi.mocked(createMatch).mockResolvedValue({ id: "match-1", status: "MATCHED" } as never);

    await negotiateAndPersist("user-a", "user-b");

    expect(mergeDeltas).toHaveBeenCalledWith("user-a");
    expect(mergeDeltas).toHaveBeenCalledWith("user-b");
    expect(runNegotiation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a", feedback: feedbackA }),
      expect.objectContaining({ userId: "user-b", feedback: EMPTY_DELTA }),
      undefined
    );
  });

  it("throws when a user does not exist", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeUser() as never);

    await expect(negotiateAndPersist("missing", "user-b")).rejects.toThrow(/not found/);
    expect(runNegotiation).not.toHaveBeenCalled();
  });

  it("throws when a user has no completed profile", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(makeUser({ profile: null }) as never)
      .mockResolvedValueOnce(makeUser() as never);

    await expect(negotiateAndPersist("user-a", "user-b")).rejects.toThrow(/no completed profile/);
    expect(runNegotiation).not.toHaveBeenCalled();
  });

  // #307: the orchestration sweep's budget guardrail needs the real spend
  // behind each negotiation without negotiateAndPersist widening its
  // Match-returning contract for every other caller.
  it("reports the negotiation's cost/duration via the optional onUsage callback", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(makeUser({ id: "user-a", name: "Alex" }) as never)
      .mockResolvedValueOnce(makeUser({ id: "user-b", name: "Blake" }) as never);
    vi.mocked(runNegotiation).mockResolvedValue(makeResult({ costUsd: 0.42, durationMs: 12345 }));
    vi.mocked(createMatch).mockResolvedValue({ id: "match-1", status: "MATCHED" } as never);
    const onUsage = vi.fn();

    await negotiateAndPersist("user-a", "user-b", undefined, onUsage);

    expect(onUsage).toHaveBeenCalledWith({ costUsd: 0.42, durationMs: 12345 });
  });

  it("does not require onUsage — omitting it is a no-op", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(makeUser({ id: "user-a", name: "Alex" }) as never)
      .mockResolvedValueOnce(makeUser({ id: "user-b", name: "Blake" }) as never);
    vi.mocked(runNegotiation).mockResolvedValue(makeResult());
    vi.mocked(createMatch).mockResolvedValue({ id: "match-1", status: "MATCHED" } as never);

    await expect(negotiateAndPersist("user-a", "user-b")).resolves.toEqual({
      id: "match-1",
      status: "MATCHED",
    });
  });
});

describe("forceMatchAndPersist", () => {
  // #345: the best-available fallback must tag its Match "FORCED" so it is
  // queryably distinct from a genuine negotiation that happened to score 6/6.
  it("persists the best-available pairing as matchType FORCED", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(makeUser({ id: "user-a", name: "Alex" }) as never)
      .mockResolvedValueOnce(makeUser({ id: "user-b", name: "Blake" }) as never);
    vi.mocked(writeFallbackRationale).mockResolvedValue("Warm honest rationale.");
    vi.mocked(createMatch).mockResolvedValue({ id: "match-forced", status: "MATCHED" } as never);

    const match = await forceMatchAndPersist("user-a", "user-b");

    expect(runNegotiation).not.toHaveBeenCalled();
    expect(createMatch).toHaveBeenCalledWith(
      "user-a",
      "user-b",
      expect.objectContaining({ scoreA: 6, scoreB: 6, matched: true }),
      "FORCED"
    );
    expect(match).toEqual({ id: "match-forced", status: "MATCHED" });
  });
});
