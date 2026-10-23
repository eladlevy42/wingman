import { faker } from "@faker-js/faker";
import { PrismaClient } from "../generated/client";
import {
  buildSeedUsers,
  buildUserProfileStructuredData,
  buildWantedProfileStructuredData,
  cityForArchetype,
  computeExpectedMatches,
  generatePersonalityTraits,
  plantEdgeCases,
} from "./seedData";
import { buildSeedTranscripts } from "./seedTranscripts";
import { WINGMAN_COUNTRY } from "@wingman/shared";
import { seedFixtures } from "./seedFixtures";
import { seedGoldenCouples, goldenPairRows } from "./goldenCouples";

const prisma = new PrismaClient();

const USER_COUNT = 500;
// Fixed seed so successive `pnpm db:seed` runs produce the same population and
// expectedMatches — needed for the eval system (Milestone 4) to compare two
// runs of the matcher against a stable ground truth.
const FAKER_SEED = 42;

async function main() {
  faker.seed(FAKER_SEED);
  const users = buildSeedUsers(USER_COUNT);
  const plantedEdgeCases = plantEdgeCases(users);
  const expectedMatchesByUserId = computeExpectedMatches(users);

  for (const user of users) {
    const city = cityForArchetype(user.archetypeIndex);
    // Every seed user is Israeli — city and country must stay correlated.
    // Shares the constant with the interview so a bot and a real profile can
    // never disagree about the country (#530).
    const country = WINGMAN_COUNTRY;
    const traits = generatePersonalityTraits(user.archetypeIndex);

    await prisma.user.create({
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        gender: user.gender,
        matchingState: "WAITING",
        expectedMatches: JSON.stringify(expectedMatchesByUserId.get(user.id)),
        profile: {
          create: {
            rawTranscript: "",
            structuredData: buildUserProfileStructuredData(user, traits, city, country),
            status: "COMPLETED",
          },
        },
        wantedProfile: {
          create: {
            structuredData: buildWantedProfileStructuredData(user, traits),
            status: "COMPLETED",
          },
        },
      },
    });
  }

  console.log(`Seeded ${users.length} users with profiles, wanted profiles, and expectedMatches.`);
  console.log("Planted edge cases for the eval ground truth:", plantedEdgeCases);

  const seedTranscripts = buildSeedTranscripts(users);
  await prisma.seedTranscript.createMany({ data: seedTranscripts });
  console.log(`Seeded ${seedTranscripts.length} transcripts for Eval Track 3.`);

  await seedFixtures(prisma);
  console.log("Seeded pinned synthetic fixture users.");

  await seedGoldenCouples(prisma);
  await prisma.goldenPair.createMany({ data: goldenPairRows() });
  console.log(`Seeded ${goldenPairRows().length} curated golden couples for Eval Track 2.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
