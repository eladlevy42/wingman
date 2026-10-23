import { describe, it, expect } from "vitest";
import { WantedProfileSchema } from "@wingman/shared";
import { WANTS_CONFIG, SELF_CONFIG } from "./interview.config";

// The config bundle is where the two interview modes actually differ. These
// tests pin the wants-specific assembly (nested ageRange, defaults) and the
// error-path → tree-field mapping the engine's re-ask logic depends on.

describe("WANTS_CONFIG.assemble", () => {
  it("folds ageMin/ageMax into a nested ageRange", () => {
    const out = WANTS_CONFIG.assemble({ ageMin: 25, ageMax: 40 });
    expect(out.ageRange).toEqual({ min: 25, max: 40 });
  });

  it("records the generous 100km default when maxDistanceKm was never collected", () => {
    const out = WANTS_CONFIG.assemble({});
    expect(out.maxDistanceKm).toBe(100);
  });

  it("keeps an explicit maxDistanceKm over the default", () => {
    const out = WANTS_CONFIG.assemble({ maxDistanceKm: 30 });
    expect(out.maxDistanceKm).toBe(30);
  });

  it("defaults every list to [] when the user gave nothing", () => {
    const out = WANTS_CONFIG.assemble({});
    for (const key of [
      "appearance",
      "personality",
      "lifestyle",
      "dealbreakers",
      "preferences",
      "compromises",
    ]) {
      expect(out[key]).toEqual([]);
    }
  });

  it("produces an object that satisfies WantedProfileSchema for a complete bag", () => {
    const out = WANTS_CONFIG.assemble({
      genderPreference: "female",
      ageMin: 25,
      ageMax: 40,
      maxDistanceKm: 50,
      appearance: ["tall"],
      personality: ["funny"],
      lifestyle: ["active"],
      dealbreakers: ["smoking"],
      preferences: ["shares a hobby"],
      compromises: ["would date a smoker"],
    });
    expect(WantedProfileSchema.safeParse(out).success).toBe(true);
  });
});

describe("WANTS_CONFIG.errorPathToField", () => {
  it("maps a nested ageRange.min error back to the ageMin node", () => {
    expect(WANTS_CONFIG.errorPathToField(["ageRange", "min"])).toBe("ageMin");
  });

  it("maps a nested ageRange.max error (incl. the min<=max refine) back to ageMax", () => {
    expect(WANTS_CONFIG.errorPathToField(["ageRange", "max"])).toBe("ageMax");
  });

  it("maps a flat field error to itself", () => {
    expect(WANTS_CONFIG.errorPathToField(["genderPreference"])).toBe("genderPreference");
    expect(WANTS_CONFIG.errorPathToField(["maxDistanceKm"])).toBe("maxDistanceKm");
  });
});

describe("SELF_CONFIG.errorPathToField", () => {
  it("uses the first path segment (self fields are flat)", () => {
    expect(SELF_CONFIG.errorPathToField(["social_energy"])).toBe("social_energy");
  });
});
