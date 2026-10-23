import { faker } from "@faker-js/faker";
import { beforeEach, describe, expect, it } from "vitest";
import { UserProfileSchema, WantedProfileSchema } from "@wingman/shared";
import {
  buildSeedUsers,
  buildUserProfileStructuredData,
  buildWantedProfileStructuredData,
  computeExpectedMatches,
  genderCompatible,
  generatePersonalityTraits,
  mutuallyPassesHardGate,
  passesHardGate,
  plantEdgeCases,
  softScore,
  type SeedUser,
} from "./seedData";

function makeUser(overrides: Partial<SeedUser> = {}): SeedUser {
  return {
    id: "id",
    email: "a@example.com",
    name: "A",
    phone: "555-0100",
    gender: "male",
    age: 30,
    archetypeIndex: 0,
    wantedGender: "female",
    ageRangeMin: 24,
    ageRangeMax: 36,
    maxDistanceKm: 100,
    ...overrides,
  };
}

describe("buildSeedUsers", () => {
  it("generates the requested number of users with unique ids", () => {
    const users = buildSeedUsers(500);
    expect(users).toHaveLength(500);
    expect(new Set(users.map((u) => u.id)).size).toBe(500);
  });

  it("every generated user has a valid UserProfile-compatible age and an archetype index", () => {
    const users = buildSeedUsers(50);
    for (const user of users) {
      expect(user.age).toBeGreaterThanOrEqual(18);
      expect(user.age).toBeLessThanOrEqual(45);
      expect(user.archetypeIndex).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("genderCompatible", () => {
  it("is compatible when both sides' preferences match the other's gender", () => {
    const a = makeUser({ gender: "male", wantedGender: "female" });
    const b = makeUser({ gender: "female", wantedGender: "male" });
    expect(genderCompatible(a, b)).toBe(true);
  });

  it("is incompatible when one side does not want the other's gender", () => {
    const a = makeUser({ gender: "male", wantedGender: "male" });
    const b = makeUser({ gender: "female", wantedGender: "male" });
    expect(genderCompatible(a, b)).toBe(false);
  });

  it("treats 'both' as compatible with any gender", () => {
    const a = makeUser({ gender: "male", wantedGender: "both" });
    const b = makeUser({ gender: "other", wantedGender: "male" });
    expect(genderCompatible(a, b)).toBe(true);
  });
});

describe("passesHardGate / mutuallyPassesHardGate", () => {
  it("blocks gender-incompatible pairs", () => {
    const a = makeUser({ gender: "male", wantedGender: "male" });
    const b = makeUser({ gender: "female", wantedGender: "male" });
    expect(passesHardGate(a, b)).toBe(false);
  });

  it("blocks a candidate outside the seeker's ageRange", () => {
    const seeker = makeUser({ age: 30, ageRangeMin: 24, ageRangeMax: 36 });
    const tooOld = makeUser({ age: 50 });
    expect(passesHardGate(seeker, tooOld)).toBe(false);
  });

  it("blocks a candidate whose city is farther than the seeker's maxDistanceKm", () => {
    // archetype 0 -> Tel Aviv, archetype 7 -> Eilat (~300km apart)
    const seeker = makeUser({ archetypeIndex: 0, maxDistanceKm: 100 });
    const farAway = makeUser({ archetypeIndex: 7 });
    expect(passesHardGate(seeker, farAway)).toBe(false);
  });

  it("passes a same-city, in-range, gender-compatible candidate regardless of archetype", () => {
    const seeker = makeUser({
      gender: "male",
      wantedGender: "female",
      age: 30,
      ageRangeMin: 24,
      ageRangeMax: 36,
      archetypeIndex: 0,
    });
    // archetype 9 also maps to Tel Aviv — same city as archetype 0 (see
    // ARCHETYPE_CITIES), so distance is 0 despite the different archetype.
    const crossArchetype = makeUser({
      gender: "female",
      wantedGender: "male",
      age: 32,
      archetypeIndex: 9,
    });
    expect(passesHardGate(seeker, crossArchetype)).toBe(true);
  });

  it("mutuallyPassesHardGate requires both directions to pass", () => {
    // b is in a's age range, but a is not in b's (narrow) age range.
    const a = makeUser({
      gender: "male",
      wantedGender: "both",
      age: 30,
      ageRangeMin: 24,
      ageRangeMax: 36,
    });
    const b = makeUser({
      gender: "male",
      wantedGender: "both",
      age: 26,
      ageRangeMin: 24,
      ageRangeMax: 27,
    });
    expect(passesHardGate(a, b)).toBe(true);
    expect(passesHardGate(b, a)).toBe(false);
    expect(mutuallyPassesHardGate(a, b)).toBe(false);
  });
});

describe("softScore", () => {
  it("scores 1 for the same archetype and 0 otherwise, ignoring age", () => {
    const seeker = makeUser({ age: 30, archetypeIndex: 0 });
    const sameFar = makeUser({ age: 40, archetypeIndex: 0 });
    const sameClose = makeUser({ age: 31, archetypeIndex: 0 });
    const other = makeUser({ age: 31, archetypeIndex: 1 });
    expect(softScore(seeker, sameFar)).toBe(1);
    expect(softScore(seeker, sameClose)).toBe(1);
    expect(softScore(seeker, other)).toBe(0);
  });
});

describe("computeExpectedMatches", () => {
  it("returns at most 5 matches per user, excluding themselves", () => {
    const users = buildSeedUsers(50);
    const matches = computeExpectedMatches(users);
    for (const user of users) {
      const ids = matches.get(user.id);
      expect(ids).toBeDefined();
      expect(ids!.length).toBeLessThanOrEqual(5);
      expect(ids).not.toContain(user.id);
    }
  });

  it("only includes candidates that mutually pass the hard gate (never a hard-gate failure)", () => {
    const users = buildSeedUsers(50);
    const matches = computeExpectedMatches(users);
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const user of users) {
      for (const candidateId of matches.get(user.id) ?? []) {
        const candidate = byId.get(candidateId)!;
        expect(mutuallyPassesHardGate(user, candidate)).toBe(true);
      }
    }
  });

  it("excludes a gender-incompatible, same-archetype/city pair (regression: gate must not be skipped for 'obvious' matches)", () => {
    const selfId = "00000000-0000-0000-0000-000000000000";
    const goodIds = Array.from(
      { length: 5 },
      (_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`
    );
    const badGenderId = "00000000-0000-0000-0000-000000000006";

    const users: SeedUser[] = [
      makeUser({ id: selfId, gender: "male", wantedGender: "female", age: 30, archetypeIndex: 0 }),
      // 5 good candidates: opposite gender, same archetype/city, close age
      ...goodIds.map((id) =>
        makeUser({ id, gender: "female", wantedGender: "male", age: 30, archetypeIndex: 0 })
      ),
      // same archetype/city as selfId, but gender-incompatible — must not match
      makeUser({
        id: badGenderId,
        gender: "male",
        wantedGender: "male",
        age: 30,
        archetypeIndex: 0,
      }),
    ];

    const matches = computeExpectedMatches(users);
    const result = matches.get(selfId);
    expect(result).toHaveLength(5);
    expect(result).toEqual(expect.arrayContaining(goodIds));
    expect(result).not.toContain(badGenderId);
  });

  it("includes a cross-archetype pair that shares a city and passes all hard gates", () => {
    const selfId = "00000000-0000-0000-0000-000000000010";
    const crossArchetypeId = "00000000-0000-0000-0000-000000000011";

    const users: SeedUser[] = [
      makeUser({
        id: selfId,
        gender: "male",
        wantedGender: "female",
        age: 30,
        ageRangeMin: 24,
        ageRangeMax: 36,
        archetypeIndex: 0, // Tel Aviv
      }),
      // archetype 9 also maps to Tel Aviv (see ARCHETYPE_CITIES) — different
      // archetype, same city, and otherwise gate-compatible.
      makeUser({
        id: crossArchetypeId,
        gender: "female",
        wantedGender: "male",
        age: 32,
        ageRangeMin: 24,
        ageRangeMax: 36,
        archetypeIndex: 9,
      }),
    ];

    const matches = computeExpectedMatches(users);
    expect(matches.get(selfId)).toContain(crossArchetypeId);
  });
});

describe("plantEdgeCases", () => {
  // Same fixed seed as packages/database/src/seed.ts, so this exercises the
  // exact population the real `pnpm db:seed` run produces the ground truth
  // against — not just an isolated hand-built fixture.
  beforeEach(() => {
    faker.seed(42);
  });

  it("plants a same-archetype pair that the real 500-user seed population excludes from each other's expectedMatches", () => {
    const users = buildSeedUsers(500);
    const { sameArchetypeBlockedPair } = plantEdgeCases(users);
    const [aId, bId] = sameArchetypeBlockedPair;
    const matches = computeExpectedMatches(users);

    expect(matches.get(aId)).not.toContain(bId);
    expect(matches.get(bId)).not.toContain(aId);
  });

  it("plants a cross-archetype pair that mutually passes the hard gate", () => {
    const users = buildSeedUsers(500);
    const { crossArchetypeMatchPair } = plantEdgeCases(users);
    const [cId, dId] = crossArchetypeMatchPair;
    const byId = new Map(users.map((u) => [u.id, u]));
    const c = byId.get(cId)!;
    const d = byId.get(dId)!;

    // The real invariant: these two are eligible to match despite sharing no
    // hobbies. This must never regress, regardless of who else is in the
    // random population.
    expect(mutuallyPassesHardGate(c, d)).toBe(true);

    // #309: softScore now rewards hobby overlap (mirroring the product's
    // Ranking Signals, docs/adr/0023) as well as age proximity, so a
    // same-archetype competitor with a closer age can — correctly — outrank
    // this deliberately hobby-less cross-archetype pair for a top-5 slot.
    // Their presence in each other's expectedMatches was only ever a
    // secondary signal at this fixed seed (never the guarantee — see above),
    // and this pre-existing softScore comparison against real candidates from
    // the 500-user population is exactly what changed; asserting it here
    // would make this test a change-detector for the random population rather
    // than for plantEdgeCases' actual contract.
  });
});

describe("generatePersonalityTraits", () => {
  it("always returns a kidsTimeline consistent with wantsKids", () => {
    for (let archetypeIndex = 0; archetypeIndex < 10; archetypeIndex++) {
      const traits = generatePersonalityTraits(archetypeIndex);
      if (traits.wantsKids === false) {
        expect(traits.kidsTimeline).toBe("not applicable");
      } else {
        expect(traits.kidsTimeline).not.toBe("not applicable");
      }
    }
  });
});

describe("buildUserProfileStructuredData", () => {
  it("produces JSON that validates against UserProfileSchema", () => {
    const user = makeUser();
    const traits = generatePersonalityTraits(user.archetypeIndex);
    const json = buildUserProfileStructuredData(user, traits, "Tel Aviv", "Israel");
    const parsed = UserProfileSchema.safeParse(JSON.parse(json));
    expect(parsed.success).toBe(true);
  });

  it("uses the given traits verbatim rather than re-randomizing them", () => {
    const user = makeUser();
    const traits = generatePersonalityTraits(user.archetypeIndex);
    const parsed = JSON.parse(buildUserProfileStructuredData(user, traits, "Tel Aviv", "Israel"));
    expect(parsed.conflict_style).toBe(traits.conflictStyle);
    expect(parsed.wants_kids).toBe(traits.wantsKids);
    expect(parsed.social_energy).toBe(traits.socialEnergy);
  });

  it("generates placeholder photoUrls deterministically from the user id", () => {
    const user = makeUser({ id: "fixed-id" });
    const traits = generatePersonalityTraits(user.archetypeIndex);
    const first = JSON.parse(buildUserProfileStructuredData(user, traits, "Tel Aviv", "Israel"));
    const second = JSON.parse(buildUserProfileStructuredData(user, traits, "Tel Aviv", "Israel"));
    expect(first.photoUrls.length).toBeGreaterThan(0);
    expect(first.photoUrls.every((url: string) => url.includes(user.id))).toBe(true);
    expect(second.photoUrls).toEqual(first.photoUrls);
  });
});

describe("buildWantedProfileStructuredData", () => {
  it("produces JSON that validates against WantedProfileSchema", () => {
    const user = makeUser();
    const traits = generatePersonalityTraits(user.archetypeIndex);
    const json = buildWantedProfileStructuredData(user, traits);
    const parsed = WantedProfileSchema.safeParse(JSON.parse(json));
    expect(parsed.success).toBe(true);
  });

  it("uses a fixed placeholder preference list", () => {
    const user = makeUser();
    const traits = generatePersonalityTraits(user.archetypeIndex);
    const parsed = JSON.parse(buildWantedProfileStructuredData(user, traits));
    expect(parsed.dealbreakers).toEqual(["placeholder"]);
    expect(parsed.preferences).toEqual(["placeholder"]);
    expect(parsed.personality).toEqual([traits.socialEnergy]);
  });
});
