import { describe, expect, it } from "vitest";
import { UserProfileSchema, WantedProfileSchema } from "./profile";

const validProfile = {
  age: 28,
  city: "Tel Aviv",
  country: "Israel",
  height: "175cm",
  job: "Product Designer",
  hometown: "Haifa",
  education: "Computer Science",
  body_type: "Athletic",
  conflict_style: "I say what's bothering me right away",
  emotional_openness: "Very open with close friends, more guarded with new people",
  treatment_of_others: "Goes out of the way to help — drove a friend to the airport at 5am",
  personality_traits: ["funny", "ambitious"],
  wants_kids: true,
  kids_timeline: "Sometime in the next 5 years",
  faith: "Jewish but not religious — cultural more than observant",
  current_motivation: "Building a career I'm proud of while staying close to family",
  life_vision: "Living abroad for a few years, then settling somewhere warm with a dog",
  hobbies: [
    { name: "hiking", centrality: "central — does it every weekend", solo_or_social: "social" },
    { name: "cooking", centrality: "casual hobby", solo_or_social: "solo" },
  ],
  typical_weekend:
    "Farmer's market Saturday morning, hike with friends in the afternoon, low-key dinner",
  social_energy: "extrovert" as const,
  social_circle: "Large but close — about 10 people she considers real friends",
};

describe("UserProfileSchema", () => {
  it("parses a fully populated profile without error", () => {
    expect(() => UserProfileSchema.parse(validProfile)).not.toThrow();
  });

  it("accepts null for all nullable fields", () => {
    const result = UserProfileSchema.parse({
      ...validProfile,
      height: null,
      job: null,
      hometown: null,
      education: null,
      body_type: null,
      conflict_style: null,
      emotional_openness: null,
      treatment_of_others: null,
      wants_kids: null,
      kids_timeline: null,
      faith: null,
      current_motivation: null,
      life_vision: null,
      typical_weekend: null,
      social_energy: null,
      social_circle: null,
    });
    expect(result.height).toBeNull();
    expect(result.wants_kids).toBeNull();
    expect(result.social_energy).toBeNull();
  });

  it('accepts "undecided" for wants_kids', () => {
    const result = UserProfileSchema.parse({ ...validProfile, wants_kids: "undecided" });
    expect(result.wants_kids).toBe("undecided");
  });

  it("accepts an empty hobbies array", () => {
    const result = UserProfileSchema.parse({ ...validProfile, hobbies: [] });
    expect(result.hobbies).toEqual([]);
  });

  it("throws ZodError for a negative age", () => {
    expect(() => UserProfileSchema.parse({ ...validProfile, age: -1 })).toThrow();
  });

  it("throws ZodError for a non-integer age", () => {
    expect(() => UserProfileSchema.parse({ ...validProfile, age: 25.5 })).toThrow();
  });

  it("throws ZodError for an invalid social_energy value", () => {
    expect(() =>
      UserProfileSchema.parse({ ...validProfile, social_energy: "party animal" })
    ).toThrow();
  });

  it("throws ZodError when a required field is missing", () => {
    const input = Object.fromEntries(Object.entries(validProfile).filter(([k]) => k !== "city"));
    expect(() => UserProfileSchema.parse(input)).toThrow();
  });

  // The multi-select collects names alone (#529), so a name-only hobby is the
  // normal persisted shape, not a partial one.
  it("accepts a hobby entry with only a name", () => {
    const result = UserProfileSchema.parse({
      ...validProfile,
      hobbies: [{ name: "hiking" }],
    });
    expect(result.hobbies).toEqual([{ name: "hiking" }]);
  });

  it("throws ZodError when a hobby entry has no name", () => {
    expect(() =>
      UserProfileSchema.parse({
        ...validProfile,
        hobbies: [{ centrality: "high", solo_or_social: "social" }],
      })
    ).toThrow();
  });

  it("throws ZodError when a hobby entry is a bare string", () => {
    expect(() => UserProfileSchema.parse({ ...validProfile, hobbies: ["hiking"] })).toThrow();
  });

  it("defaults education to null when omitted", () => {
    const input = Object.fromEntries(
      Object.entries(validProfile).filter(([k]) => k !== "education")
    );
    const result = UserProfileSchema.parse(input);
    expect(result.education).toBeNull();
  });

  it("defaults photoUrls to an empty array when omitted", () => {
    const result = UserProfileSchema.parse(validProfile);
    expect(result.photoUrls).toEqual([]);
  });

  it("accepts explicit placeholder photoUrls", () => {
    const result = UserProfileSchema.parse({
      ...validProfile,
      photoUrls: ["https://i.pravatar.cc/400?u=abc-0"],
    });
    expect(result.photoUrls).toEqual(["https://i.pravatar.cc/400?u=abc-0"]);
  });

  it("throws ZodError when a photoUrl is not a valid URL", () => {
    expect(() => UserProfileSchema.parse({ ...validProfile, photoUrls: ["not-a-url"] })).toThrow();
  });

  it("parses without additionalNotes (#251) — omitted, not defaulted", () => {
    const result = UserProfileSchema.parse(validProfile);
    expect(result.additionalNotes).toBeUndefined();
  });

  it("accepts an explicit additionalNotes string", () => {
    const result = UserProfileSchema.parse({
      ...validProfile,
      additionalNotes: "Allergic to cats.",
    });
    expect(result.additionalNotes).toBe("Allergic to cats.");
  });

  it("accepts null for body_type (#252)", () => {
    const result = UserProfileSchema.parse({ ...validProfile, body_type: null });
    expect(result.body_type).toBeNull();
  });

  it("accepts an empty personality_traits array (#252)", () => {
    const result = UserProfileSchema.parse({ ...validProfile, personality_traits: [] });
    expect(result.personality_traits).toEqual([]);
  });

  it("defaults personality_traits to an empty array when omitted", () => {
    const input = Object.fromEntries(
      Object.entries(validProfile).filter(([k]) => k !== "personality_traits")
    );
    const result = UserProfileSchema.parse(input);
    expect(result.personality_traits).toEqual([]);
  });

  it("defaults body_type to null when omitted", () => {
    const input = Object.fromEntries(
      Object.entries(validProfile).filter(([k]) => k !== "body_type")
    );
    const result = UserProfileSchema.parse(input);
    expect(result.body_type).toBeNull();
  });
});

const validWantedProfile = {
  genderPreference: "female" as const,
  ageRange: { min: 25, max: 35 },
  maxDistanceKm: 50,
  appearance: ["tall", "athletic"],
  personality: ["funny", "ambitious"],
  lifestyle: ["non-smoker", "active"],
  dealbreakers: ["smoking"],
  preferences: ["shares a hobby"],
  compromises: ["willing to date a smoker if strongly compatible"],
};

describe("WantedProfileSchema", () => {
  it("parses a fully populated wanted profile without error", () => {
    expect(() => WantedProfileSchema.parse(validWantedProfile)).not.toThrow();
  });

  it("accepts empty arrays for any preference list", () => {
    const result = WantedProfileSchema.parse({ ...validWantedProfile, appearance: [] });
    expect(result.appearance).toEqual([]);
  });

  it("throws ZodError for an invalid genderPreference value", () => {
    expect(() =>
      WantedProfileSchema.parse({ ...validWantedProfile, genderPreference: "unknown" })
    ).toThrow();
  });

  it("throws ZodError for a non-positive maxDistanceKm", () => {
    expect(() => WantedProfileSchema.parse({ ...validWantedProfile, maxDistanceKm: 0 })).toThrow();
  });

  it("throws ZodError for a non-integer ageRange bound", () => {
    expect(() =>
      WantedProfileSchema.parse({
        ...validWantedProfile,
        ageRange: { min: 25.5, max: 35 },
      })
    ).toThrow();
  });

  it("throws ZodError when ageRange.min is greater than ageRange.max", () => {
    expect(() =>
      WantedProfileSchema.parse({
        ...validWantedProfile,
        ageRange: { min: 40, max: 20 },
      })
    ).toThrow();
  });

  it("accepts ageRange where min equals max", () => {
    const result = WantedProfileSchema.parse({
      ...validWantedProfile,
      ageRange: { min: 30, max: 30 },
    });
    expect(result.ageRange).toEqual({ min: 30, max: 30 });
  });

  it("throws ZodError when a required field is missing", () => {
    const input = Object.fromEntries(
      Object.entries(validWantedProfile).filter(([k]) => k !== "maxDistanceKm")
    );
    expect(() => WantedProfileSchema.parse(input)).toThrow();
  });

  it("accepts an explicit additionalNotes string (#251)", () => {
    const result = WantedProfileSchema.parse({
      ...validWantedProfile,
      additionalNotes: "Would love someone who already has a dog.",
    });
    expect(result.additionalNotes).toBe("Would love someone who already has a dog.");
  });
});
