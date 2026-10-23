import { faker } from "@faker-js/faker";
import {
  UserProfileSchema,
  WantedProfileSchema,
  ExpectedMatchesSchema,
  cityToCoords,
  haversineDistanceKm,
  type GoldenPairCategory,
} from "@wingman/shared";

export const EXPECTED_MATCHES_PER_USER = 5;

// Wingman is student-only for now, so every seeded profile gets a plausible
// field of study — faker has no built-in generator for this.
const FIELDS_OF_STUDY = [
  "Computer Science",
  "Psychology",
  "Business Administration",
  "Biology",
  "Mechanical Engineering",
  "Political Science",
  "Graphic Design",
  "Economics",
  "Nursing",
  "English Literature",
] as const;

// Mirrors the wants tree's `appearance` node (docs/adr/0021) — a plausible
// self-described build for every seeded profile.
const BODY_TYPES = ["athletic", "average", "slim", "curvy", "muscular"] as const;

// Mirrors the wants tree's `personality` node (docs/adr/0021).
const PERSONALITY_TRAITS = [
  "funny",
  "ambitious",
  "laid-back",
  "adventurous",
  "creative",
  "thoughtful",
  "confident",
  "easygoing",
] as const;

// Synthetic hobby buckets for the demo seed. Not a production ranking model.
export const ARCHETYPES = [
  { hobbies: ["hiking", "climbing", "camping"], lifestyle: ["outdoorsy", "early riser"] },
  { hobbies: ["reading", "writing", "museums"], lifestyle: ["homebody", "quiet nights in"] },
  {
    hobbies: ["clubbing", "live music", "festivals"],
    lifestyle: ["night owl", "social butterfly"],
  },
  { hobbies: ["cooking", "wine tasting", "hosting dinners"], lifestyle: ["foodie", "homebody"] },
  { hobbies: ["gym", "running", "cycling"], lifestyle: ["fitness-focused", "early riser"] },
  { hobbies: ["gaming", "anime", "tech"], lifestyle: ["night owl", "homebody"] },
  { hobbies: ["yoga", "meditation", "journaling"], lifestyle: ["mindful", "early riser"] },
  { hobbies: ["travel", "photography", "languages"], lifestyle: ["adventurous", "spontaneous"] },
  { hobbies: ["volunteering", "activism", "community events"], lifestyle: ["community-oriented"] },
  { hobbies: ["painting", "pottery", "design"], lifestyle: ["creative", "homebody"] },
] as const;

// One city per archetype (same index as ARCHETYPES), drawn from the known-city
// list in packages/shared/src/geo.ts. Distance is resolved from
// `Profile.structuredData.city` via a static lookup. Every seed user's country
// is Israel, so city and country stay correlated.
const ARCHETYPE_CITIES: readonly string[] = [
  "Tel Aviv", // hiking/climbing/camping
  "Jerusalem", // reading/writing/museums
  "Herzliya", // clubbing/live music/festivals
  "Ashdod", // cooking/wine tasting/dinners
  "Petah Tikva", // gym/running/cycling
  "Rishon LeZion", // gaming/anime/tech
  "Haifa", // yoga/meditation/journaling
  "Eilat", // travel/photography/languages
  "Beer Sheva", // volunteering/activism/community
  "Netanya", // painting/pottery/design
];

type Weighted<T> = { value: T; weight: number };

interface PersonalityBundle {
  conflictStyle: Weighted<string>[];
  emotionalOpenness: Weighted<string>[];
  treatmentOfOthers: Weighted<string>[];
  socialEnergy: Weighted<"introvert" | "extrovert" | "ambivert">[];
  faith: Weighted<string>[];
  wantsKids: Weighted<boolean | "undecided">[];
  motivations: string[];
  lifeVisions: string[];
  weekends: string[];
}

// One generic personality bundle. The per-archetype model is omitted.
const PERSONALITY_PROFILES: readonly PersonalityBundle[] = [
  {
    conflictStyle: [{ value: "direct", weight: 1 }],
    emotionalOpenness: [{ value: "open", weight: 1 }],
    treatmentOfOthers: [{ value: "kind", weight: 1 }],
    socialEnergy: [{ value: "ambivert", weight: 1 }],
    faith: [{ value: "none", weight: 1 }],
    wantsKids: [{ value: "undecided", weight: 1 }],
    motivations: ["Example motivation"],
    lifeVisions: ["Example vision"],
    weekends: ["Example weekend"],
  },
];

export interface PersonalityTraits {
  conflictStyle: string;
  emotionalOpenness: string;
  treatmentOfOthers: string;
  socialEnergy: "introvert" | "extrovert" | "ambivert";
  faith: string;
  wantsKids: boolean | "undecided";
  kidsTimeline: string;
  motivation: string;
  lifeVision: string;
  typicalWeekend: string;
}

function pickWeighted<T>(pool: readonly Weighted<T>[]): T {
  return faker.helpers.weightedArrayElement(pool as Weighted<T>[]);
}

function kidsTimelineFor(wantsKids: boolean | "undecided"): string {
  if (wantsKids === true) return faker.helpers.arrayElement(["soon", "in a few years"]);
  if (wantsKids === false) return "not applicable";
  return "not sure";
}

// Sampled once per user so the same-archetype "lean" shows through without
// cloning every user in an archetype into an identical personality.
export function generatePersonalityTraits(archetypeIndex: number): PersonalityTraits {
  const bundle = PERSONALITY_PROFILES[archetypeIndex % PERSONALITY_PROFILES.length];
  const wantsKids = pickWeighted(bundle.wantsKids);
  return {
    conflictStyle: pickWeighted(bundle.conflictStyle),
    emotionalOpenness: pickWeighted(bundle.emotionalOpenness),
    treatmentOfOthers: pickWeighted(bundle.treatmentOfOthers),
    socialEnergy: pickWeighted(bundle.socialEnergy),
    faith: pickWeighted(bundle.faith),
    wantsKids,
    kidsTimeline: kidsTimelineFor(wantsKids),
    motivation: faker.helpers.arrayElement(bundle.motivations),
    lifeVision: faker.helpers.arrayElement(bundle.lifeVisions),
    typicalWeekend: faker.helpers.arrayElement(bundle.weekends),
  };
}

export type Gender = "male" | "female" | "other";
export type GenderPreference = "male" | "female" | "both" | "other";

export interface SeedUser {
  id: string;
  email: string;
  name: string;
  phone: string;
  gender: Gender;
  age: number;
  archetypeIndex: number;
  wantedGender: GenderPreference;
  // Generated once here (not re-rolled in buildWantedProfileStructuredData) so
  // the ground-truth expectedMatches and the actual WantedProfile agree on
  // what "compatible" means for this user.
  ageRangeMin: number;
  ageRangeMax: number;
  maxDistanceKm: number;
}

export function genderCompatible(a: SeedUser, b: SeedUser): boolean {
  const aWantsB = a.wantedGender === "both" || a.wantedGender === b.gender;
  const bWantsA = b.wantedGender === "both" || b.wantedGender === a.gender;
  return aWantsB && bWantsA;
}

// Mirrors apps/api/src/services/matching.service.ts's passesHardCriteria
// (docs/adr/0006): gender, ageRange, maxDistanceKm only. Directional — must be
// checked both ways (see mutuallyPassesHardGate) because ageRange/maxDistanceKm
// are per-seeker, just like in the real engine.
export function passesHardGate(seeker: SeedUser, other: SeedUser): boolean {
  const genderOk = seeker.wantedGender === "both" || seeker.wantedGender === other.gender;
  if (!genderOk) return false;

  if (other.age < seeker.ageRangeMin || other.age > seeker.ageRangeMax) return false;

  const seekerCoords = cityToCoords(cityForArchetype(seeker.archetypeIndex));
  const otherCoords = cityToCoords(cityForArchetype(other.archetypeIndex));
  if (haversineDistanceKm(seekerCoords, otherCoords) > seeker.maxDistanceKm) return false;

  return true;
}

export function mutuallyPassesHardGate(a: SeedUser, b: SeedUser): boolean {
  return passesHardGate(a, b) && passesHardGate(b, a);
}

// Proprietary compatibility scoring is omitted in the public showcase version.
// Placeholder: 1 when two seed users share an archetype index, otherwise 0.
export function softScore(seeker: SeedUser, other: SeedUser): number {
  return seeker.archetypeIndex === other.archetypeIndex ? 1 : 0;
}

export function buildSeedUsers(count: number): SeedUser[] {
  return Array.from({ length: count }, (_, i) => {
    const gender = faker.helpers.arrayElement<Gender>(["male", "female", "other"]);
    const age = faker.number.int({ min: 18, max: 45 });
    return {
      id: faker.string.uuid(),
      email: faker.internet.email({ firstName: `user${i}` }).toLowerCase(),
      name: faker.person.fullName(),
      phone: faker.phone.number(),
      gender,
      age,
      archetypeIndex: i % ARCHETYPES.length,
      wantedGender: faker.helpers.arrayElement<GenderPreference>(["male", "female", "both"]),
      // Wide enough that most users have >= 5 mutually gate-passing
      // candidates in a 500-person seed population (empirically tuned —
      // narrower ranges left ~9% of users with zero matches).
      ageRangeMin: Math.max(18, age - 9),
      ageRangeMax: age + 9,
      maxDistanceKm: faker.number.int({ min: 40, max: 150 }),
    };
  });
}

export function cityForArchetype(archetypeIndex: number): string {
  return ARCHETYPE_CITIES[archetypeIndex];
}

export interface PlantedEdgeCases {
  // Same archetype and city, but hard-gate blocked by age — must be absent
  // from each other's expectedMatches.
  sameArchetypeBlockedPair: [string, string];
  // Different archetype, same city, and otherwise gate-compatible — must be
  // present in each other's expectedMatches.
  crossArchetypeMatchPair: [string, string];
}

// Mutates 4 users in-place so the eval dataset contains at least one instance
// of each edge case the deterministic gate is supposed to get right, not just
// the isolated unit-test cases in seedData.test.ts. Call after buildSeedUsers
// and before computeExpectedMatches. Requires users.length >= 4.
export function plantEdgeCases(users: SeedUser[]): PlantedEdgeCases {
  const [a, b, c, d] = users;

  a.archetypeIndex = 0; // Tel Aviv
  b.archetypeIndex = 0; // same archetype/city as a
  a.gender = "male";
  a.wantedGender = "female";
  b.gender = "female";
  b.wantedGender = "male";
  a.age = 25;
  a.ageRangeMin = 20;
  a.ageRangeMax = 30;
  b.age = 45; // outside a's ageRange and vice versa
  b.ageRangeMin = 40;
  b.ageRangeMax = 50;
  a.maxDistanceKm = 100;
  b.maxDistanceKm = 100;

  c.archetypeIndex = 0; // Tel Aviv
  d.archetypeIndex = 9; // also Tel Aviv, different archetype/hobbies
  c.gender = "male";
  c.wantedGender = "female";
  d.gender = "female";
  d.wantedGender = "male";
  // Identical ages, so this pair is not separated by the age axis of the gate.
  c.age = 30;
  c.ageRangeMin = 24;
  c.ageRangeMax = 36;
  d.age = 30;
  d.ageRangeMin = 24;
  d.ageRangeMax = 36;
  c.maxDistanceKm = 50;
  d.maxDistanceKm = 50;

  return {
    sameArchetypeBlockedPair: [a.id, b.id],
    crossArchetypeMatchPair: [c.id, d.id],
  };
}

// Ground truth for the eval system (Milestone 4): must use the same hard
// gates as the real deterministicFilter (docs/adr/0006), or expectedMatches
// will contain pairs the real engine would reject as too far apart or outside
// each other's stated age range.
export function computeExpectedMatches(users: SeedUser[]): Map<string, string[]> {
  const expectedMatchesByUserId = new Map<string, string[]>();
  for (const user of users) {
    const ranked = users
      .filter((candidate) => candidate.id !== user.id)
      .filter((candidate) => mutuallyPassesHardGate(user, candidate))
      .sort((a, b) => softScore(user, b) - softScore(user, a))
      .slice(0, EXPECTED_MATCHES_PER_USER)
      .map((candidate) => candidate.id);

    expectedMatchesByUserId.set(user.id, ExpectedMatchesSchema.parse(ranked));
  }
  return expectedMatchesByUserId;
}

export function buildUserProfileStructuredData(
  user: SeedUser,
  traits: PersonalityTraits,
  city: string,
  country: string
) {
  const archetype = ARCHETYPES[user.archetypeIndex];
  const profile = UserProfileSchema.parse({
    age: user.age,
    city,
    country,
    height: `${faker.number.int({ min: 155, max: 195 })}cm`,
    job: faker.person.jobTitle(),
    hometown: faker.location.city(),
    education: faker.helpers.arrayElement(FIELDS_OF_STUDY),
    body_type: faker.helpers.arrayElement(BODY_TYPES),
    conflict_style: traits.conflictStyle,
    emotional_openness: traits.emotionalOpenness,
    treatment_of_others: traits.treatmentOfOthers,
    personality_traits: faker.helpers.arrayElements(PERSONALITY_TRAITS, { min: 2, max: 4 }),
    wants_kids: traits.wantsKids,
    kids_timeline: traits.kidsTimeline,
    faith: traits.faith,
    current_motivation: traits.motivation,
    life_vision: traits.lifeVision,
    hobbies: archetype.hobbies.map((name) => ({
      name,
      centrality: faker.helpers.arrayElement(["core to who I am", "important", "casual"]),
      solo_or_social: faker.helpers.arrayElement(["solo", "social", "both"]),
    })),
    typical_weekend: traits.typicalWeekend,
    social_energy: traits.socialEnergy,
    social_circle: faker.helpers.arrayElement(["small and close", "wide and active"]),
    photoUrls: buildPlaceholderPhotoUrls(user.id),
  });
  return JSON.stringify(profile);
}

// Deterministic placeholder photos per user, per issue #31. `u` seeds pravatar
// so the same user always gets the same set of images across seed runs.
function buildPlaceholderPhotoUrls(userId: string, count = 3): string[] {
  return Array.from({ length: count }, (_, i) => `https://i.pravatar.cc/400?u=${userId}-${i}`);
}

// Proprietary preference model is omitted in the public showcase version.
export function buildWantedProfileStructuredData(user: SeedUser, traits: PersonalityTraits) {
  const archetype = ARCHETYPES[user.archetypeIndex];
  const wanted = WantedProfileSchema.parse({
    genderPreference: user.wantedGender,
    ageRange: { min: user.ageRangeMin, max: user.ageRangeMax },
    maxDistanceKm: user.maxDistanceKm,
    appearance: ["any"],
    personality: [traits.socialEnergy],
    lifestyle: [...archetype.lifestyle],
    dealbreakers: ["placeholder"],
    preferences: ["placeholder"],
    compromises: ["distance"],
  });
  return JSON.stringify(wanted);
}

export interface GoldenPairSeed {
  userAId: string;
  userBId: string;
  goldenScore: number;
  category: GoldenPairCategory;
}

export const GOLDEN_PAIR_SCORE_RANGES: Record<GoldenPairCategory, [number, number]> = {
  compatible: [7, 9],
  incompatible: [1, 4],
  borderline: [5, 6],
};

// Golden-pair labeling used to be derived here by scanning the random
// population for the first pairs whose traits classified into each category
// (issue #393, ADR 0029). That builder (buildGoldenPairs and friends) is
// retired — golden pairs are now 10 hand-authored couples in
// `goldenCouples.ts` (issue #420), so the category/score no longer needs to
// be inferred from a random population's traits at all.
