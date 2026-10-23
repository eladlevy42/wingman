import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  deterministicFilter,
  scoreCandidates,
  bestAvailableCandidateId,
  rejectionExclusionMs,
} from "./matching.service";

vi.mock("@wingman/database", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    match: {
      findMany: vi.fn(),
    },
  },
  // The tombstone id the guards under test exclude by identity (docs/adr/0040).
  DELETED_USER_ID: "00000000-0000-4000-8000-000000000000",
}));

import { prisma, DELETED_USER_ID } from "@wingman/database";

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "user-1",
    gender: "female",
    matchingState: "WAITING",
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
        hobbies: [{ name: "hiking", centrality: "central", solo_or_social: "social" }],
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

// prisma.match.findMany backs two independent lookups (REJECTED for #344,
// MATCHED for #375) distinguished only by `where.status` — route each call
// to its own fixture so setting up one history doesn't leak into the other.
function mockMatchHistory({
  rejected = [],
  matched = [],
}: {
  rejected?: Array<{ userAId: string; userBId: string }>;
  matched?: Array<{ userAId: string; userBId: string }>;
} = {}) {
  vi.mocked(prisma.match.findMany).mockImplementation(((args: unknown) => {
    const status = (args as { where: { status: string } }).where.status;
    return Promise.resolve(status === "MATCHED" ? matched : rejected);
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no rejection or match history. Individual #344/#375 tests override this.
  mockMatchHistory();
});

describe("deterministicFilter", () => {
  it("excludes a candidate whose gender doesn't match the seeker's genderPreference", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeUser({
        id: "candidate-1",
        gender: "female",
        wantedProfile: makeUser().wantedProfile,
      }),
    ] as never);

    const result = await deterministicFilter("seeker");

    expect(result).not.toContain("candidate-1");
  });

  it("excludes a candidate outside the seeker's ageRange", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    const tooOld = makeUser({ id: "candidate-1", gender: "male" });
    tooOld.profile.structuredData = JSON.stringify({
      ...JSON.parse(tooOld.profile.structuredData),
      age: 60,
    });
    vi.mocked(prisma.user.findMany).mockResolvedValue([tooOld] as never);

    const result = await deterministicFilter("seeker");

    expect(result).not.toContain("candidate-1");
  });

  it("excludes a candidate outside the seeker's maxDistanceKm", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    const farAway = makeUser({ id: "candidate-1", gender: "male" });
    farAway.profile.structuredData = JSON.stringify({
      ...JSON.parse(farAway.profile.structuredData),
      city: "New York",
    });
    vi.mocked(prisma.user.findMany).mockResolvedValue([farAway] as never);

    const result = await deterministicFilter("seeker");

    expect(result).not.toContain("candidate-1");
  });

  it("does not exclude an unknown-city candidate on the distance gate (#331)", async () => {
    // A known far city (New York) is excluded by distance; an unlocatable city
    // can't be reliably distance-checked, so it passes the gate rather than
    // being rejected — or wrongly admitted — on a fabricated Tel Aviv position.
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    const unknownCity = makeUser({ id: "candidate-1", gender: "male" });
    unknownCity.profile.structuredData = JSON.stringify({
      ...JSON.parse(unknownCity.profile.structuredData),
      city: "Atlantis",
    });
    unknownCity.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(unknownCity.wantedProfile.structuredData),
      genderPreference: "female",
    });
    vi.mocked(prisma.user.findMany).mockResolvedValue([unknownCity] as never);

    const result = await deterministicFilter("seeker");

    expect(result).toContain("candidate-1");
  });

  it("excludes a candidate when the match fails in the reverse direction (candidate doesn't want the seeker)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    const pickyCandidate = makeUser({ id: "candidate-1", gender: "male" });
    pickyCandidate.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(pickyCandidate.wantedProfile.structuredData),
      // genderPreference is set to "female" (reciprocating the seeker) so
      // the ageRange mismatch below is the actual reason this candidate is
      // excluded, not an incidental gender mismatch from the fixture default.
      genderPreference: "female",
      ageRange: { min: 50, max: 60 },
    });
    vi.mocked(prisma.user.findMany).mockResolvedValue([pickyCandidate] as never);

    const result = await deterministicFilter("seeker");

    expect(result).not.toContain("candidate-1");
  });

  it("includes a mutually compatible candidate", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    // The candidate must reciprocate the seeker's gender preference in both
    // directions (per ADR 0006), so its wantedProfile.genderPreference is
    // overridden to "female" here — reusing the fixture default ("male")
    // would make the candidate want a male partner, which the female seeker
    // is not, and mutuality would fail. This deviates from the task brief's
    // literal fixture, which left wantedProfile unmodified; see task-2-report.md.
    const candidate = makeUser({ id: "candidate-1", gender: "male" });
    candidate.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(candidate.wantedProfile.structuredData),
      genderPreference: "female",
    });
    vi.mocked(prisma.user.findMany).mockResolvedValue([candidate] as never);

    const result = await deterministicFilter("seeker");

    expect(result).toContain("candidate-1");
  });

  it("returns at most 5 results ordered by hobby overlap score descending", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    const candidates = Array.from({ length: 7 }, (_, i) => {
      const c = makeUser({ id: `candidate-${i}`, gender: "male" });
      // Reciprocate the seeker's gender preference (see note in the
      // "mutually compatible" test above) so these candidates aren't all
      // excluded by the reverse-direction gender check.
      c.wantedProfile.structuredData = JSON.stringify({
        ...JSON.parse(c.wantedProfile.structuredData),
        genderPreference: "female",
      });
      // candidate-0 shares the "hiking" hobby with the seeker (score 1), rest share none (score 0)
      if (i !== 0) {
        c.profile.structuredData = JSON.stringify({
          ...JSON.parse(c.profile.structuredData),
          hobbies: [{ name: "chess", centrality: "casual", solo_or_social: "solo" }],
        });
      }
      return c;
    });
    vi.mocked(prisma.user.findMany).mockResolvedValue(candidates as never);

    const result = await deterministicFilter("seeker");

    expect(result.length).toBeLessThanOrEqual(5);
    expect(result[0]).toBe("candidate-0");
  });

  it("keeps a zero-overlap candidate off the shortlist (rank stays null) while a positive-overlap candidate gets ranked (#334)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    const overlapping = makeUser({ id: "candidate-overlap", gender: "male" });
    overlapping.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(overlapping.wantedProfile.structuredData),
      genderPreference: "female",
    });
    const zeroOverlap = makeUser({ id: "candidate-zero", gender: "male" });
    zeroOverlap.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(zeroOverlap.wantedProfile.structuredData),
      genderPreference: "female",
    });
    zeroOverlap.profile.structuredData = JSON.stringify({
      ...JSON.parse(zeroOverlap.profile.structuredData),
      hobbies: [{ name: "chess", centrality: "casual", solo_or_social: "solo" }],
    });
    vi.mocked(prisma.user.findMany).mockResolvedValue([overlapping, zeroOverlap] as never);

    const scored = await scoreCandidates("seeker");

    const overlapResult = scored.find((s) => s.candidateId === "candidate-overlap");
    const zeroResult = scored.find((s) => s.candidateId === "candidate-zero");
    expect(overlapResult?.passedHardCriteria).toBe(true);
    expect(overlapResult?.rank).toBe(0);
    expect(zeroResult?.passedHardCriteria).toBe(true);
    expect(zeroResult?.overlapScore).toBe(0);
    expect(zeroResult?.rank).toBeNull();
  });

  it("returns an empty shortlist, not a zero-overlap one, when every hard-criteria-passing candidate scores 0 (#334)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    const zeroOverlap = makeUser({ id: "candidate-zero", gender: "male" });
    zeroOverlap.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(zeroOverlap.wantedProfile.structuredData),
      genderPreference: "female",
    });
    zeroOverlap.profile.structuredData = JSON.stringify({
      ...JSON.parse(zeroOverlap.profile.structuredData),
      hobbies: [{ name: "chess", centrality: "casual", solo_or_social: "solo" }],
    });
    vi.mocked(prisma.user.findMany).mockResolvedValue([zeroOverlap] as never);

    const result = await deterministicFilter("seeker");

    expect(result).toEqual([]);
  });

  it("skips a candidate with malformed structuredData while still returning a valid compatible candidate", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);

    const malformedJson = makeUser({ id: "candidate-bad", gender: "male" });
    malformedJson.profile.structuredData = "not valid json";
    malformedJson.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(malformedJson.wantedProfile.structuredData),
      genderPreference: "female",
    });

    const validCandidate = makeUser({ id: "candidate-good", gender: "male" });
    validCandidate.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(validCandidate.wantedProfile.structuredData),
      genderPreference: "female",
    });

    vi.mocked(prisma.user.findMany).mockResolvedValue([malformedJson, validCandidate] as never);

    const result = await deterministicFilter("seeker");

    expect(result).toContain("candidate-good");
    expect(result).not.toContain("candidate-bad");
  });

  it("queries only WAITING users, excluding the seeker and the tombstone", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    await deterministicFilter("seeker");

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          matchingState: "WAITING",
          // The deleted-user tombstone is excluded by id, not by trusting its
          // IDLE matchingState, which other paths can overwrite (docs/adr/0040).
          id: { notIn: ["seeker", DELETED_USER_ID] },
        }),
      })
    );
  });
});

// Ranking Signals (#300, docs/adr/0023): weighted multi-signal scoring with
// normalization and deterministic tie-breaks. Ranking only — the hard-criteria
// tests above are the proof nothing here filters anyone out.
describe("Ranking Signals", () => {
  // A male candidate reciprocating the female seeker, with profile fields
  // overridden per test.
  function makeCandidate(id: string, profileOverrides: Record<string, unknown> = {}) {
    const c = makeUser({ id, gender: "male" });
    c.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(c.wantedProfile.structuredData),
      genderPreference: "female",
    });
    c.profile.structuredData = JSON.stringify({
      ...JSON.parse(c.profile.structuredData),
      ...profileOverrides,
    });
    return c;
  }

  async function scoresById(seeker: unknown, candidates: unknown[]) {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(seeker as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue(candidates as never);
    const scored = await scoreCandidates("seeker");
    return new Map(scored.map((s) => [s.candidateId, s]));
  }

  it("scores 1 for a shared hobby name and ignores case", async () => {
    const byId = await scoresById(makeUser({ id: "seeker" }), [
      makeCandidate("cased", {
        hobbies: [{ name: "Hiking", centrality: "central", solo_or_social: "social" }],
      }),
      makeCandidate("unrelated", {
        hobbies: [{ name: "chess", centrality: "casual", solo_or_social: "solo" }],
      }),
    ]);

    expect(byId.get("cased")?.overlapScore).toBe(1);
    expect(byId.get("unrelated")?.overlapScore).toBe(0);
  });

  it("does not treat word variants or synonyms as the same hobby", async () => {
    const byId = await scoresById(makeUser({ id: "seeker" }), [
      makeCandidate("variant", {
        hobbies: [{ name: "hikes", centrality: "central", solo_or_social: "social" }],
      }),
      makeCandidate("baking", {
        hobbies: [{ name: "baking", centrality: "central", solo_or_social: "social" }],
      }),
    ]);

    expect(byId.get("variant")?.overlapScore).toBe(0);
    expect(byId.get("baking")?.overlapScore).toBe(0);
  });

  it("scores a flat point no matter how many hobby names are shared", async () => {
    const many = ["hiking", "chess", "cooking", "climbing", "reading", "cycling"].map((name) => ({
      name,
      centrality: "casual",
      solo_or_social: "solo",
    }));
    const seeker = makeUser({ id: "seeker" });
    seeker.profile.structuredData = JSON.stringify({
      ...JSON.parse(seeker.profile.structuredData),
      hobbies: many,
    });
    const byId = await scoresById(seeker, [
      makeCandidate("verbose", { hobbies: many }),
      makeCandidate("one", {
        hobbies: [{ name: "hiking", centrality: "casual", solo_or_social: "solo" }],
      }),
    ]);

    expect(byId.get("verbose")?.overlapScore).toBe(1);
    expect(byId.get("one")?.overlapScore).toBe(1);
  });

  it("does not score personality, social energy, or kids", async () => {
    const seeker = makeUser({ id: "seeker" });
    seeker.profile.structuredData = JSON.stringify({
      ...JSON.parse(seeker.profile.structuredData),
      hobbies: [],
      personality_traits: ["curious"],
      social_energy: "introvert",
      wants_kids: true,
    });
    const byId = await scoresById(seeker, [
      makeCandidate("aligned", {
        hobbies: [],
        personality_traits: ["curious"],
        social_energy: "introvert",
        wants_kids: true,
      }),
      makeCandidate("clash", { hobbies: [], wants_kids: false }),
    ]);

    expect(byId.get("aligned")?.overlapScore).toBe(0);
    expect(byId.get("clash")?.overlapScore).toBe(0);
    expect(byId.get("clash")?.passedHardCriteria).toBe(true);
  });

  it("breaks equal scores by distance then candidate id — never DB row order", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    // All three share the seeker's hobby (equal score). Haifa is ~90km from the
    // Tel Aviv seeker, Herzliya ~10km; the two Herzliya candidates tie on
    // distance and fall through to the id tie-break. DB order is deliberately
    // worst-case (farthest and highest id first).
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCandidate("far-haifa", { city: "Haifa" }),
      makeCandidate("z-herzliya", { city: "Herzliya" }),
      makeCandidate("a-herzliya", { city: "Herzliya" }),
    ] as never);

    const result = await deterministicFilter("seeker");

    expect(result).toEqual(["a-herzliya", "z-herzliya", "far-haifa"]);
  });

  it("ranks unknown-city candidates below known-city ones and never as 0 km 'closest' (#331)", async () => {
    // All three share the seeker's hobby (equal score). The seeker is in Tel
    // Aviv: the Tel Aviv candidate is genuinely 0 km, while the two unknown
    // cities only *fall back* to Tel Aviv (0 km). Before #331 the unknowns tied
    // the known one on distance and the lowest id ("a-atlantis") won. Now the
    // known-distance candidate sorts first regardless of id, and the two
    // unknowns fall to the id tie-break between themselves.
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCandidate("a-atlantis", { city: "Atlantis" }),
      makeCandidate("b-narnia", { city: "Narnia" }),
      makeCandidate("z-telaviv", { city: "Tel Aviv" }),
    ] as never);

    const result = await deterministicFilter("seeker");

    expect(result).toEqual(["z-telaviv", "a-atlantis", "b-narnia"]);
  });
});

// #377: documents rejectionExclusionMs's actual disable semantics — only an
// exact 0 disables the exclusion; a negative or unparseable value warns and
// falls back to the 7-day default rather than disabling it (the comment used
// to claim otherwise).
describe("rejectionExclusionMs (#377)", () => {
  afterEach(() => {
    delete process.env.REJECTION_EXCLUSION_DAYS;
  });

  it("disables the exclusion only on an exact 0", () => {
    process.env.REJECTION_EXCLUSION_DAYS = "0";
    expect(rejectionExclusionMs()).toBe(0);
  });

  it("warns and falls back to the 7-day default on a negative value", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.REJECTION_EXCLUSION_DAYS = "-1";

    expect(rejectionExclusionMs()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("warns and falls back to the 7-day default on an unparseable value", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.REJECTION_EXCLUSION_DAYS = "abc";

    expect(rejectionExclusionMs()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("defaults to 7 days when unset", () => {
    delete process.env.REJECTION_EXCLUSION_DAYS;
    expect(rejectionExclusionMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// Recently-rejected exclusion (#344): a pair the agent negotiation already
// turned down within the exclusion window is kept out of the negotiated
// shortlist, so the same doomed negotiation isn't paid for every sweep.
describe("recently-rejected exclusion (#344)", () => {
  function makeCompatibleCandidate(id: string) {
    const c = makeUser({ id, gender: "male" });
    c.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(c.wantedProfile.structuredData),
      genderPreference: "female",
    });
    return c;
  }

  afterEach(() => {
    delete process.env.REJECTION_EXCLUSION_DAYS;
  });

  it("excludes a candidate rejected within the window and marks it recently_rejected", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("candidate-1"),
    ] as never);
    // A REJECTED match from yesterday, with the seeker as userB (the other
    // side is userA) — proves both directions are collected.
    mockMatchHistory({ rejected: [{ userAId: "candidate-1", userBId: "seeker" }] });

    const scored = await scoreCandidates("seeker");
    const candidate = scored.find((s) => s.candidateId === "candidate-1");

    expect(candidate?.passedHardCriteria).toBe(false);
    expect(candidate?.failureReason).toBe("recently_rejected");
    expect(candidate?.rank).toBeNull();
    expect(await deterministicFilter("seeker")).not.toContain("candidate-1");
  });

  it("queries only the seeker's REJECTED matches since the window cutoff", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    await scoreCandidates("seeker");

    expect(prisma.match.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "REJECTED",
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
          OR: [{ userAId: "seeker" }, { userBId: "seeker" }],
        }),
      })
    );
  });

  it("keeps a stale rejection (outside the window) eligible again", async () => {
    // The exclusion source is the DB query itself: a rejection older than the
    // window is filtered out by the `createdAt >= cutoff` clause, so it never
    // reaches the exclusion set. Modeling that here means match.findMany
    // returns empty for the stale rejection, and the candidate is negotiable.
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("candidate-1"),
    ] as never);
    vi.mocked(prisma.match.findMany).mockResolvedValue([] as never);

    const result = await deterministicFilter("seeker");

    expect(result).toContain("candidate-1");
  });

  it("disables the exclusion (and skips the REJECTED query) when REJECTION_EXCLUSION_DAYS=0", async () => {
    process.env.REJECTION_EXCLUSION_DAYS = "0";
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("candidate-1"),
    ] as never);

    const result = await deterministicFilter("seeker");

    expect(result).toContain("candidate-1");
    // The #375 previously-matched check is unconditional, so match.findMany is
    // still called for that — but never with the REJECTED-window query.
    expect(prisma.match.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "REJECTED" }) })
    );
  });
});

// Previously-matched exclusion (#375): a pair that already completed a match
// (and went on a date) must never be re-matched, even after both users cycle
// back to WAITING post-debrief. Permanent — independent of
// REJECTION_EXCLUSION_DAYS, and checked in both scoreCandidates and the
// bestAvailableCandidateId fallback.
describe("previously-matched exclusion (#375)", () => {
  function makeCompatibleCandidate(id: string) {
    const c = makeUser({ id, gender: "male" });
    c.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(c.wantedProfile.structuredData),
      genderPreference: "female",
    });
    return c;
  }

  it("excludes a previously-matched candidate from the shortlist and marks it already_matched", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("candidate-1"),
    ] as never);
    // A completed match with the seeker as userB — proves both directions
    // are collected, and the row's status is MATCHED (not REJECTED).
    mockMatchHistory({ matched: [{ userAId: "candidate-1", userBId: "seeker" }] });

    const scored = await scoreCandidates("seeker");
    const candidate = scored.find((s) => s.candidateId === "candidate-1");

    expect(candidate?.passedHardCriteria).toBe(false);
    expect(candidate?.failureReason).toBe("already_matched");
    expect(candidate?.rank).toBeNull();
    expect(await deterministicFilter("seeker")).not.toContain("candidate-1");
  });

  it("leaves an unrelated candidate unaffected when only a different candidate was previously matched", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("past-date"),
      makeCompatibleCandidate("unrelated"),
    ] as never);
    mockMatchHistory({ matched: [{ userAId: "seeker", userBId: "past-date" }] });

    const scored = await scoreCandidates("seeker");
    const pastDate = scored.find((s) => s.candidateId === "past-date");
    const unrelated = scored.find((s) => s.candidateId === "unrelated");

    expect(pastDate?.failureReason).toBe("already_matched");
    expect(unrelated?.passedHardCriteria).toBe(true);
    expect(unrelated?.failureReason).toBeNull();
    expect(await deterministicFilter("seeker")).toContain("unrelated");
  });

  it("queries the seeker's MATCHED rows with no createdAt window (permanent, unlike recently_rejected)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    await scoreCandidates("seeker");

    expect(prisma.match.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "MATCHED",
          OR: [{ userAId: "seeker" }, { userBId: "seeker" }],
        },
      })
    );
  });

  it("is not disabled by REJECTION_EXCLUSION_DAYS=0 (separate rule from the rejection window)", async () => {
    process.env.REJECTION_EXCLUSION_DAYS = "0";
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("candidate-1"),
    ] as never);
    mockMatchHistory({ matched: [{ userAId: "seeker", userBId: "candidate-1" }] });

    const result = await deterministicFilter("seeker");

    expect(result).not.toContain("candidate-1");
    delete process.env.REJECTION_EXCLUSION_DAYS;
  });

  it("folds previously-matched ids into the fallback's notIn query alongside caller-supplied excludeIds", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);
    mockMatchHistory({ matched: [{ userAId: "seeker", userBId: "past-date" }] });

    await bestAvailableCandidateId("seeker", new Set(["already-tried"]));

    const call = vi.mocked(prisma.user.findMany).mock.calls[0][0] as unknown as {
      where: { id: { notIn: string[] } };
    };
    expect(call.where.id.notIn).toEqual(
      expect.arrayContaining(["seeker", "already-tried", "past-date"])
    );
  });

  it("queries the seeker's MATCHED rows (not just REJECTED) before running the fallback", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    await bestAvailableCandidateId("seeker");

    expect(prisma.match.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "MATCHED",
          OR: [{ userAId: "seeker" }, { userBId: "seeker" }],
        },
      })
    );
  });
});

// #335: the always-return-someone fallback must not force-pair a seeker with a
// candidate whose own genderPreference excludes them when a mutually-acceptable
// candidate is available — while still guaranteeing a result if that's the only
// person waiting.
describe("bestAvailableCandidateId — mutual gender preference", () => {
  // A male candidate for the female seeker fixture. `wantsSeeker` controls
  // whether the candidate reciprocates the seeker's gender.
  function makeMaleCandidate(
    id: string,
    wantsSeeker: boolean,
    profileOverrides: Record<string, unknown> = {}
  ) {
    const c = makeUser({ id, gender: "male" });
    c.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(c.wantedProfile.structuredData),
      genderPreference: wantsSeeker ? "female" : "male",
    });
    c.profile.structuredData = JSON.stringify({
      ...JSON.parse(c.profile.structuredData),
      ...profileOverrides,
    });
    return c;
  }

  it("prefers a mutually-acceptable candidate over a higher-scoring one-directional one", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      // One-directional: seeker wants him, but he wants males — excludes the
      // seeker. Shares the seeker's "hiking" hobby, so he outscores the mutual
      // candidate and would win under a seeker-only gender check.
      makeMaleCandidate("one-way", false, {
        hobbies: [{ name: "hiking", centrality: "central", solo_or_social: "social" }],
      }),
      // Mutually acceptable but shares no hobby (lower score).
      makeMaleCandidate("mutual", true, {
        hobbies: [{ name: "chess", centrality: "casual", solo_or_social: "solo" }],
      }),
    ] as never);

    const result = await bestAvailableCandidateId("seeker");

    expect(result).toBe("mutual");
  });

  it("still returns a candidate when the only waiting user is one-directional (guarantee holds)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeMaleCandidate("only-one-way", false),
    ] as never);

    const result = await bestAvailableCandidateId("seeker");

    expect(result).toBe("only-one-way");
  });

  // #379: the gender ranking calls the shared genderAcceptable helper
  // directly rather than inferring acceptability from hardCriteriaFailure's
  // returned failure code. This candidate independently fails the gender check
  // and the age check, but only gender matters here: genderAcceptable considers
  // gender alone, so the candidate is ranked gender-unacceptable regardless of
  // the age mismatch. Before the fix, ranking read hardCriteriaFailure's code
  // and only reported "gender" because gender is checked first there; a future
  // reorder could have flipped that code to "age" and broken the ranking. Now
  // that the ranking no longer reads that result, such a reorder cannot break it.
  it("ranks a gender-unacceptable candidate (who also fails age) as gender-unacceptable", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    const genderAndAgeMismatch = makeMaleCandidate("gender-and-age-mismatch", false, { age: 60 });
    const mutualMatch = makeMaleCandidate("mutual-match", true);
    vi.mocked(prisma.user.findMany).mockResolvedValue([genderAndAgeMismatch, mutualMatch] as never);

    const result = await bestAvailableCandidateId("seeker");

    expect(result).toBe("mutual-match");
  });
});

// #374: the best-available fallback must consult the same #344 rejection
// window scoreCandidates uses, so the automatic sweep can't force-pair a
// couple the agents just rejected — while the manual guaranteeMatch
// last-resort pass can still deliberately override it.
describe("bestAvailableCandidateId — recently-rejected exclusion (#374)", () => {
  function makeCompatibleCandidate(id: string) {
    const c = makeUser({ id, gender: "male" });
    c.wantedProfile.structuredData = JSON.stringify({
      ...JSON.parse(c.wantedProfile.structuredData),
      genderPreference: "female",
    });
    return c;
  }

  afterEach(() => {
    delete process.env.REJECTION_EXCLUSION_DAYS;
  });

  // The recently-rejected exclusion is folded into the DB query's notIn (like
  // the #375 previously-matched fold above), so these tests assert on the
  // findMany call's where clause — the mocked findMany ignores its args, so
  // return-value assertions alone couldn't prove the exclusion reached the DB.
  function candidatePoolNotIn(): string[] {
    const call = vi.mocked(prisma.user.findMany).mock.calls[0][0] as unknown as {
      where: { id: { notIn: string[] } };
    };
    return call.where.id.notIn;
  }

  it("excludes a recently-rejected candidate from the pool query on the default (automatic) path", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("available"),
    ] as never);
    mockMatchHistory({ rejected: [{ userAId: "rejected", userBId: "seeker" }] });

    const result = await bestAvailableCandidateId("seeker");

    expect(candidatePoolNotIn()).toEqual(expect.arrayContaining(["seeker", "rejected"]));
    expect(result).toBe("available");
  });

  it("returns null when every waiting candidate was recently rejected", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    // The DB honors the notIn exclusion, so the filtered pool comes back empty.
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
    mockMatchHistory({ rejected: [{ userAId: "rejected", userBId: "seeker" }] });

    const result = await bestAvailableCandidateId("seeker");

    expect(candidatePoolNotIn()).toEqual(expect.arrayContaining(["rejected"]));
    expect(result).toBeNull();
  });

  it("re-admits a recently-rejected candidate when respectRejectionWindow is false", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("rejected"),
    ] as never);
    mockMatchHistory({ rejected: [{ userAId: "rejected", userBId: "seeker" }] });

    const result = await bestAvailableCandidateId("seeker", new Set(), {
      respectRejectionWindow: false,
    });

    expect(candidatePoolNotIn()).not.toContain("rejected");
    expect(result).toBe("rejected");
    // The #375 previously-matched check is unconditional, so match.findMany is
    // still called for MATCHED rows — but never with the REJECTED-window query.
    expect(prisma.match.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "REJECTED" }) })
    );
  });

  it("does not query rejection history when the exclusion window is disabled", async () => {
    process.env.REJECTION_EXCLUSION_DAYS = "0";
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      makeCompatibleCandidate("rejected"),
    ] as never);

    const result = await bestAvailableCandidateId("seeker");

    expect(candidatePoolNotIn()).not.toContain("rejected");
    expect(result).toBe("rejected");
    expect(prisma.match.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "REJECTED" }) })
    );
  });

  it("uses caller-precomputed exclusion sets without re-querying match history", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ id: "seeker" }) as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);

    await bestAvailableCandidateId("seeker", new Set(), {
      respectRejectionWindow: true,
      recentlyRejectedIds: new Set(["rejected"]),
      previouslyMatchedIds: new Set(["past-date"]),
    });

    expect(candidatePoolNotIn()).toEqual(expect.arrayContaining(["rejected", "past-date"]));
    expect(prisma.match.findMany).not.toHaveBeenCalled();
  });
});
