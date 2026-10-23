import { UserProfileSchema, WantedProfileSchema } from "@wingman/shared";
import type { UserProfile, WantedProfile } from "@wingman/shared";
import type { PrismaClient } from "../generated/client";
import { deleteUserAccounts } from "./userDeletion";

// Two synthetic pinned users so a re-seed can demo the match flow without
// touching the generated population. No real account data is included.
const ALEX_PHOTO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2Ij48cmVjdCB3aWR0aD0iMjU2IiBoZWlnaHQ9IjI1NiIgZmlsbD0iIzYzNjZmMSIvPjwvc3ZnPg==";
const SAM_PHOTO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2Ij48cmVjdCB3aWR0aD0iMjU2IiBoZWlnaHQ9IjI1NiIgZmlsbD0iI2Y0NzJiNiIvPjwvc3ZnPg==";

export interface FixtureUser {
  id: string;
  email: string;
  name: string;
  phone: string;
  gender: string;
  photoUrl: string;
  profile: UserProfile;
  wanted: WantedProfile;
}

function demoProfile(age: number): UserProfile {
  return UserProfileSchema.parse({
    age,
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
    social_energy: "ambivert",
    social_circle: null,
    photoUrls: [],
  });
}

function demoWanted(genderPreference: "male" | "female"): WantedProfile {
  return WantedProfileSchema.parse({
    genderPreference,
    ageRange: { min: 21, max: 35 },
    maxDistanceKm: 50,
    appearance: [],
    personality: ["placeholder"],
    lifestyle: [],
    dealbreakers: ["placeholder"],
    preferences: ["placeholder"],
    compromises: [],
  });
}

const ALEX: FixtureUser = {
  id: "c0ffee00-0000-4000-8000-0000000000a1",
  email: "alex.fixture@example.com",
  name: "Alex Demo",
  phone: "n/a",
  gender: "male",
  photoUrl: ALEX_PHOTO,
  profile: demoProfile(28),
  wanted: demoWanted("female"),
};

const SAM: FixtureUser = {
  id: "c0ffee00-0000-4000-8000-0000000000b2",
  email: "sam.fixture@example.com",
  name: "Sam Demo",
  phone: "n/a",
  gender: "female",
  photoUrl: SAM_PHOTO,
  profile: demoProfile(27),
  wanted: demoWanted("male"),
};

export const FIXTURE_USERS: readonly FixtureUser[] = [ALEX, SAM];

function fixtureUserCreateData(f: FixtureUser) {
  return {
    id: f.id,
    email: f.email,
    name: f.name,
    phone: f.phone,
    gender: f.gender,
    photoUrl: f.photoUrl,
    matchingState: "WAITING" as const,
    profile: {
      create: {
        rawTranscript: "",
        structuredData: JSON.stringify(f.profile),
        status: "COMPLETED" as const,
      },
    },
    wantedProfile: {
      create: { structuredData: JSON.stringify(f.wanted), status: "COMPLETED" as const },
    },
  };
}

export async function seedFixtureUsers(
  prisma: PrismaClient,
  users: readonly FixtureUser[]
): Promise<void> {
  const ids = users.map((u) => u.id);
  const emails = users.map((u) => u.email);

  const existingUsers = await prisma.user.findMany({
    where: { OR: [{ id: { in: ids } }, { email: { in: emails } }] },
    select: { id: true },
  });
  const existingIds = existingUsers.map((u) => u.id);

  await deleteUserAccounts(prisma, existingIds, "purge");

  for (const f of users) {
    await prisma.user.create({ data: fixtureUserCreateData(f) });
  }
}

export async function seedFixtures(prisma: PrismaClient): Promise<void> {
  await seedFixtureUsers(prisma, FIXTURE_USERS);
}
