import { UserProfileSchema } from "@wingman/shared";
import { cityForArchetype, type SeedUser } from "./seedData";

export interface SeedTranscriptSeed {
  userId: string;
  rawTranscript: string;
  expectedStructuredProfile: string;
}

// One synthetic transcript. The hand-authored eval corpus is omitted.
export function buildSeedTranscripts(users: SeedUser[]): SeedTranscriptSeed[] {
  const user = users[0];
  if (!user) {
    throw new Error("buildSeedTranscripts: need at least one seeded user.");
  }

  const profile = UserProfileSchema.parse({
    age: user.age,
    city: cityForArchetype(user.archetypeIndex),
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
  });

  return [
    {
      userId: user.id,
      rawTranscript: "Barney: [redacted]\nUser: A synthetic answer.",
      expectedStructuredProfile: JSON.stringify(profile),
    },
  ];
}
