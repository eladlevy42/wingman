import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../generated/client";
import { deleteUserAccount, deleteUserAccounts, DELETED_USER_ID } from "./userDeletion";
import { FIXTURE_USERS, seedFixtures } from "./seedFixtures";

// The only test in the repo that runs against a real database, and it has to:
// the thing under test is which foreign keys block a delete and which cascade,
// and a mocked prisma client cannot have a foreign key. So this pushes the real
// schema into a throwaway SQLite file.
//
// The schema's datasource url is hardcoded (`file:./wingman.db`) and does not
// read an env var, so `prisma db push` is pointed at a copy of the schema whose
// url is rewritten — otherwise it would push into the dev database.

const packageRoot = process.cwd();
const schemaPath = join(packageRoot, "prisma", "schema.prisma");
// The .bin launcher is `prisma` on POSIX and `prisma.CMD` on Windows, and
// execFileSync cannot exec a .cmd without a shell — without both halves of this
// `pnpm test` fails outright on a Windows checkout (CLAUDE.md §7).
const isWindows = process.platform === "win32";
const prismaBin = join(packageRoot, "node_modules", ".bin", isWindows ? "prisma.cmd" : "prisma");

let tempDir: string;
let prisma: PrismaClient;

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const MATCH_ID = "33333333-3333-4333-8333-333333333333";

beforeAll(() => {
  if (!existsSync(schemaPath)) {
    throw new Error(
      `Expected the Prisma schema at ${schemaPath}. This test resolves paths from the ` +
        `working directory and must run from packages/database (pnpm --filter @wingman/database test).`
    );
  }

  tempDir = mkdtempSync(join(tmpdir(), "wingman-user-deletion-"));
  const dbUrl = `file:${join(tempDir, "test.db")}`;

  const tempSchema = join(tempDir, "schema.prisma");
  writeFileSync(
    tempSchema,
    readFileSync(schemaPath, "utf-8").replace(/url\s*=\s*"file:[^"]*"/, `url = "${dbUrl}"`)
  );

  execFileSync(prismaBin, ["db", "push", "--schema", tempSchema, "--skip-generate"], {
    // CHECKPOINT_DISABLE keeps the CLI from reaching for its version check.
    env: { ...process.env, CHECKPOINT_DISABLE: "1" },
    stdio: "pipe",
    shell: isWindows,
  });

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Builds the user this issue is actually about: someone who has been all the
 * way through a cycle, so every one of the seven blocking relations has a row.
 * USER_A is the one being deleted; USER_B is the other participant.
 */
async function seedFullCycleUsers(): Promise<void> {
  for (const [id, email, name] of [
    [USER_A, "a@example.com", "A"],
    [USER_B, "b@example.com", "B"],
  ]) {
    await prisma.user.create({
      data: {
        id,
        email,
        name,
        phone: "555-0100",
        gender: "female",
        matchingState: "DATE_ASSIGNED",
        photoUrl: "data:image/png;base64,xxx",
        universityEmail: `${name}@mail.tau.ac.il`,
        studentId: "123456",
        passwordHash: "hash",
        universityPasswordHash: "hash",
        profile: { create: { rawTranscript: "my answers", structuredData: "{}" } },
        wantedProfile: { create: { rawTranscript: "my wants", structuredData: "{}" } },
        pushTokens: { create: { token: `ExponentPushToken[${id}]`, platform: "ios" } },
        notifications: { create: { type: "MATCH_FOUND", payload: "{}" } },
        seedTranscripts: {
          create: { rawTranscript: "transcript", expectedStructuredProfile: "{}" },
        },
        matchAttempts: { create: { status: "MATCHED", candidateScores: "[]", matchIds: "[]" } },
      },
    });
  }

  await prisma.match.create({
    data: {
      id: MATCH_ID,
      userAId: USER_A,
      userBId: USER_B,
      status: "MATCHED",
      scoreA: 8,
      scoreB: 9,
      deliberationLog: "the negotiation",
      rationale: "why they fit",
      proposerId: USER_A,
      followUps: {
        create: [
          { userId: USER_A, state: "DEBRIEFED" },
          { userId: USER_B, state: "DEBRIEFED" },
        ],
      },
      feedbackRounds: {
        create: [
          { userId: USER_A, rawTranscript: "A's debrief", delta: "{}" },
          { userId: USER_B, rawTranscript: "B's debrief", delta: "{}" },
        ],
      },
    },
  });

  await prisma.goldenPair.create({
    data: { userAId: USER_A, userBId: USER_B, goldenScore: 8, category: "compatible" },
  });
  await prisma.interviewSessionSnapshot.create({
    data: { id: "session-a", userId: USER_A, mode: "interview_self", state: "{}" },
  });
}

/** Every user id referenced by a row that must always resolve to a real user. */
async function danglingReferences(): Promise<string[]> {
  const userIds = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
  const referenced: string[] = [];

  for (const match of await prisma.match.findMany({
    select: { userAId: true, userBId: true, proposerId: true },
  })) {
    referenced.push(match.userAId, match.userBId);
    if (match.proposerId) referenced.push(match.proposerId);
  }
  for (const row of await prisma.followUp.findMany({ select: { userId: true } })) {
    referenced.push(row.userId);
  }
  for (const row of await prisma.feedbackRound.findMany({ select: { userId: true } })) {
    referenced.push(row.userId);
  }
  for (const row of await prisma.matchAttempt.findMany({ select: { userId: true } })) {
    referenced.push(row.userId);
  }

  return [...new Set(referenced.filter((id) => !userIds.has(id)))];
}

beforeEach(async () => {
  // Order matters only because Match blocks on its participants.
  await prisma.feedbackRound.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.match.deleteMany();
  await prisma.goldenPair.deleteMany();
  await prisma.matchAttempt.deleteMany();
  await prisma.interviewSessionSnapshot.deleteMany();
  await prisma.user.deleteMany();
  await seedFullCycleUsers();
});

describe("deleteUserAccount (anonymize) — a user who completed a full cycle", () => {
  it("deletes without a foreign-key error and removes the user row", async () => {
    await expect(deleteUserAccount(prisma, USER_A)).resolves.toBe(true);
    expect(await prisma.user.findUnique({ where: { id: USER_A } })).toBeNull();
  });

  it("erases everything the user owned alone", async () => {
    await deleteUserAccount(prisma, USER_A);

    expect(await prisma.profile.findUnique({ where: { userId: USER_A } })).toBeNull();
    expect(await prisma.wantedProfile.findUnique({ where: { userId: USER_A } })).toBeNull();
    expect(await prisma.pushToken.count({ where: { userId: USER_A } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: USER_A } })).toBe(0);
    expect(await prisma.seedTranscript.count({ where: { userId: USER_A } })).toBe(0);
    expect(await prisma.interviewSessionSnapshot.count({ where: { userId: USER_A } })).toBe(0);
    // Eval ground truth, not date history — the pair goes with the user.
    expect(await prisma.goldenPair.count()).toBe(0);
    // Their own debrief, in their own words.
    expect(await prisma.feedbackRound.count({ where: { userId: USER_A } })).toBe(0);
    expect(await prisma.followUp.count({ where: { userId: USER_A } })).toBe(0);
  });

  it("keeps the match and repoints the departing side at the tombstone", async () => {
    await deleteUserAccount(prisma, USER_A);

    const match = await prisma.match.findUnique({ where: { id: MATCH_ID } });
    expect(match).not.toBeNull();
    expect(match?.userAId).toBe(DELETED_USER_ID);
    expect(match?.userBId).toBe(USER_B);
    // proposerId is a plain column with no constraint to catch it.
    expect(match?.proposerId).toBe(DELETED_USER_ID);
    expect(match?.deliberationLog).toBe("the negotiation");
    expect(match?.rationale).toBe("why they fit");

    const tombstone = await prisma.user.findUnique({ where: { id: DELETED_USER_ID } });
    expect(tombstone?.name).toBe("Deleted user");
    // IDLE is what keeps it out of every candidate query.
    expect(tombstone?.matchingState).toBe("IDLE");
  });

  it("leaves the other participant's record of their own date untouched", async () => {
    await deleteUserAccount(prisma, USER_A);

    const survivor = await prisma.user.findUnique({ where: { id: USER_B } });
    expect(survivor).not.toBeNull();
    // Not stranded: nothing about the surviving user's position moved.
    expect(survivor?.matchingState).toBe("DATE_ASSIGNED");

    const round = await prisma.feedbackRound.findUnique({
      where: { userId_matchId: { userId: USER_B, matchId: MATCH_ID } },
    });
    expect(round?.rawTranscript).toBe("B's debrief");
    expect(await prisma.followUp.count({ where: { userId: USER_B, matchId: MATCH_ID } })).toBe(1);
    expect(await prisma.profile.findUnique({ where: { userId: USER_B } })).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: USER_B } })).toBe(1);
  });

  it("keeps the match-attempt history, repointed at the tombstone", async () => {
    const result = await deleteUserAccounts(prisma, [USER_A]);

    expect(result.anonymizedMatchAttempts).toBe(1);
    expect(await prisma.matchAttempt.count({ where: { userId: USER_A } })).toBe(0);
    expect(await prisma.matchAttempt.count({ where: { userId: DELETED_USER_ID } })).toBe(1);
  });

  it("leaves no dangling user reference behind", async () => {
    await deleteUserAccount(prisma, USER_A);
    expect(await danglingReferences()).toEqual([]);
  });

  it("reuses the one tombstone across deletions instead of creating another", async () => {
    await deleteUserAccount(prisma, USER_A);
    await deleteUserAccount(prisma, USER_B);

    expect(await prisma.user.count()).toBe(1);
    const match = await prisma.match.findUnique({ where: { id: MATCH_ID } });
    expect(match?.userAId).toBe(DELETED_USER_ID);
    expect(match?.userBId).toBe(DELETED_USER_ID);
    expect(await danglingReferences()).toEqual([]);
  });

  it("creates no tombstone for a user who never reached a match", async () => {
    const loner = "55555555-5555-4555-8555-555555555555";
    await prisma.user.create({
      data: { id: loner, email: "l@example.com", name: "L", phone: "0", gender: "male" },
    });

    await deleteUserAccount(prisma, loner);

    expect(await prisma.user.findUnique({ where: { id: DELETED_USER_ID } })).toBeNull();
  });

  it("reports an unknown id as not deleted and changes nothing", async () => {
    await expect(deleteUserAccount(prisma, "44444444-4444-4444-8444-444444444444")).resolves.toBe(
      false
    );
    expect(await prisma.user.count()).toBe(2);
  });

  it("refuses to delete the tombstone itself", async () => {
    await deleteUserAccount(prisma, USER_A);
    await expect(deleteUserAccount(prisma, DELETED_USER_ID)).resolves.toBe(false);
    expect(await prisma.user.findUnique({ where: { id: DELETED_USER_ID } })).not.toBeNull();
  });
});

describe("deleteUserAccounts (purge) — the fixture teardown", () => {
  it("takes the shared match with it instead of anonymising", async () => {
    const result = await deleteUserAccounts(prisma, [USER_A], "purge");

    expect(result.purgedMatches).toBe(1);
    expect(await prisma.match.count()).toBe(0);
    expect(await prisma.followUp.count()).toBe(0);
    expect(await prisma.feedbackRound.count()).toBe(0);
    expect(await prisma.matchAttempt.count({ where: { userId: USER_A } })).toBe(0);
    // No tombstone row: a re-seed is a replacement, not an erasure.
    expect(await prisma.user.findUnique({ where: { id: DELETED_USER_ID } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: USER_B } })).not.toBeNull();
  });

  it("clears a fixture user who has match attempts and notifications", async () => {
    // The exact case the old hand-rolled teardown would have hit a foreign key on.
    await expect(deleteUserAccounts(prisma, [USER_A, USER_B], "purge")).resolves.toMatchObject({
      deletedUserIds: expect.arrayContaining([USER_A, USER_B]),
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.matchAttempt.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("seedFixtures re-seeding", () => {
  it("re-seeds a fixture user who has been through a full cycle", async () => {
    // Clear the per-test fixtures first — Match and MatchAttempt Restrict, which
    // is exactly why a bare user.deleteMany() is not a teardown.
    await deleteUserAccounts(prisma, [USER_A, USER_B], "purge");
    await seedFixtures(prisma);

    // The rows the old hand-rolled teardown never handled: a fixture user who
    // has actually run through the app has these, and the second seed used to
    // hit a foreign key on them.
    const [first, second] = FIXTURE_USERS;
    await prisma.matchAttempt.create({
      data: { userId: first.id, status: "MATCHED", candidateScores: "[]", matchIds: "[]" },
    });
    await prisma.notification.create({
      data: { userId: first.id, type: "MATCH_FOUND", payload: "{}" },
    });
    await prisma.match.create({
      data: { userAId: first.id, userBId: second.id, status: "MATCHED", scoreA: 8, scoreB: 8 },
    });

    await expect(seedFixtures(prisma)).resolves.toBeUndefined();

    expect(await prisma.user.count({ where: { id: { in: [first.id, second.id] } } })).toBe(2);
    expect(await prisma.matchAttempt.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.match.count()).toBe(0);
    expect(await danglingReferences()).toEqual([]);
  });
});
