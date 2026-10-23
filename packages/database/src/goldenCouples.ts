import { UserProfileSchema, WantedProfileSchema, type GoldenPairCategory } from "@wingman/shared";
import type { PrismaClient } from "../generated/client";
import { seedFixtureUsers, type FixtureUser } from "./seedFixtures";
import type { GoldenPairSeed } from "./seedData";

// Showcase stand-in for the curated eval couples. One synthetic pair that
// mutually passes the hard gate. The original labelled dataset is omitted.
export interface GoldenCouple {
  userA: FixtureUser;
  userB: FixtureUser;
  goldenScore: number;
  category: GoldenPairCategory;
}

function syntheticUser(
  id: string,
  email: string,
  name: string,
  gender: "male" | "female"
): FixtureUser {
  const seeks = gender === "female" ? "male" : "female";
  return {
    id,
    email,
    name,
    phone: "n/a",
    gender,
    photoUrl: "",
    profile: UserProfileSchema.parse({
      age: gender === "female" ? 28 : 30,
      city: "Tel Aviv",
      country: "Israel",
      height: null,
      job: "Example",
      hometown: null,
      education: null,
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
      hobbies: [{ name: "reading" }],
      typical_weekend: null,
      social_energy: null,
      social_circle: null,
      photoUrls: [],
    }),
    wanted: WantedProfileSchema.parse({
      genderPreference: seeks,
      ageRange: { min: 24, max: 36 },
      maxDistanceKm: 50,
      appearance: [],
      personality: [],
      lifestyle: [],
      dealbreakers: ["placeholder"],
      preferences: ["placeholder"],
      compromises: [],
    }),
  };
}

export const GOLDEN_COUPLES: GoldenCouple[] = [
  {
    userA: syntheticUser(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "alex.demo@example.com",
      "Alex Demo",
      "female"
    ),
    userB: syntheticUser(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      "sam.demo@example.com",
      "Sam Demo",
      "male"
    ),
    goldenScore: 7,
    category: "compatible",
  },
];

export function goldenCoupleUsers(): FixtureUser[] {
  return GOLDEN_COUPLES.flatMap((c) => [c.userA, c.userB]);
}

export function goldenPairRows(): GoldenPairSeed[] {
  return GOLDEN_COUPLES.map((c) => ({
    userAId: c.userA.id,
    userBId: c.userB.id,
    goldenScore: c.goldenScore,
    category: c.category,
  }));
}

export async function seedGoldenCouples(prisma: PrismaClient): Promise<void> {
  await seedFixtureUsers(prisma, goldenCoupleUsers());
}
