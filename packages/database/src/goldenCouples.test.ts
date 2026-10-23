import { describe, it, expect } from "vitest";
import { GOLDEN_COUPLES, goldenCoupleUsers, goldenPairRows } from "./goldenCouples";
import { UserProfileSchema, WantedProfileSchema } from "@wingman/shared";

describe("GOLDEN_COUPLES", () => {
  it("ships one synthetic compatible couple in the showcase build", () => {
    expect(GOLDEN_COUPLES).toHaveLength(1);
    expect(GOLDEN_COUPLES[0]?.goldenScore).toBeGreaterThanOrEqual(7);
    expect(GOLDEN_COUPLES[0]?.category).toBe("compatible");
  });

  it("every fixture user has a schema-valid profile and wanted, unique id/email", () => {
    const users = goldenCoupleUsers();
    expect(users).toHaveLength(2);
    for (const u of users) {
      expect(() => UserProfileSchema.parse(u.profile)).not.toThrow();
      expect(() => WantedProfileSchema.parse(u.wanted)).not.toThrow();
    }
    expect(new Set(users.map((u) => u.id)).size).toBe(2);
    expect(new Set(users.map((u) => u.email)).size).toBe(2);
  });

  it("the couple mutually passes the hard gate so it can reach negotiation", () => {
    for (const c of GOLDEN_COUPLES) {
      const { userA: a, userB: b } = c;
      expect(a.wanted.genderPreference).toBe(b.gender);
      expect(b.wanted.genderPreference).toBe(a.gender);
      expect(b.profile.age).toBeGreaterThanOrEqual(a.wanted.ageRange.min);
      expect(b.profile.age).toBeLessThanOrEqual(a.wanted.ageRange.max);
      expect(a.profile.age).toBeGreaterThanOrEqual(b.wanted.ageRange.min);
      expect(a.profile.age).toBeLessThanOrEqual(b.wanted.ageRange.max);
      expect(a.profile.city).toBe(b.profile.city);
    }
  });

  it("golden pair rows reference real fixture users", () => {
    const ids = new Set(goldenCoupleUsers().map((u) => u.id));
    for (const row of goldenPairRows()) {
      expect(ids.has(row.userAId)).toBe(true);
      expect(ids.has(row.userBId)).toBe(true);
    }
  });
});
