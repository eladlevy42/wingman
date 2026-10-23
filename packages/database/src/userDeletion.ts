import type { PrismaClient } from "../generated/client";

/**
 * User deletion, in one place because two callers need it: the account-erasure
 * endpoint (DELETE /api/users/:id) and the fixture teardown in seedFixtures.ts,
 * which lives in this package and cannot import from apps/api.
 *
 * The shape of the decision is docs/adr/0040. In one sentence: everything the
 * user owns alone is erased, and the departing side of a record they share with
 * someone else is repointed at a reserved tombstone user, so deleting one
 * account never erases the other participant's history of their own date.
 */

// The reserved tombstone every departed participant is repointed at. A fixed
// id so it is recognisable in a raw DB dump and stable across environments.
// Format is a valid v4 UUID so it survives any z.string().uuid() it meets.
//
// Callers must exclude this id BY IDENTITY, never by trusting its matchingState.
// IDLE is not self-defending: several paths update both participants of a Match
// by id (decision.service's rejectMatch, scheduling.service's
// startTimeSelection/assignDate, orchestration.service's
// handleNegotiationOutcome), and a Match with an anonymised side hands them the
// tombstone like any other participant. rejectMatch in particular fires on its
// own — a deleted user can never answer Yeah/Nah, so the decision window always
// expires — and would flip the tombstone to WAITING, after which the sweep
// would treat a deleted account as a live seeker (docs/adr/0040).
export const DELETED_USER_ID = "00000000-0000-4000-8000-000000000000";

const DELETED_USER_EMAIL = "deleted-user@wingman.invalid";

// Interactive-transaction budget for one teardown. Well above anything the POC
// does (a purge of the whole fixture set is a handful of statements) and well
// below a hang.
const TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * - `anonymize` — real erasure. Shared records (Match, MatchAttempt) survive
 *   with the departing side repointed at the tombstone.
 * - `purge` — fixture teardown. The shared records go too. Re-seeding a fixture
 *   user is a replacement, not an erasure: anonymising there would leave a
 *   tombstoned Match behind on every `pnpm db:seed`.
 */
export type UserDeletionMode = "anonymize" | "purge";

export interface UserDeletionResult {
  /** Ids that actually existed and were deleted. */
  deletedUserIds: string[];
  /** Matches whose departing side was repointed at the tombstone (`anonymize`). */
  anonymizedMatches: number;
  /** Match attempts repointed at the tombstone (`anonymize`). */
  anonymizedMatchAttempts: number;
  /** Matches deleted outright, with their follow-ups and feedback (`purge`). */
  purgedMatches: number;
}

// A fresh object per call rather than one shared constant: the result carries a
// mutable array, and a caller that pushes to a shared one would corrupt it for
// every later caller in the process.
function emptyResult(): UserDeletionResult {
  return {
    deletedUserIds: [],
    anonymizedMatches: 0,
    anonymizedMatchAttempts: 0,
    purgedMatches: 0,
  };
}

/**
 * Deletes users by id, resolving every relation that would otherwise block the
 * delete. Ids that do not exist are skipped silently — the caller decides
 * whether "not found" is an error (the endpoint answers 404; the fixture
 * teardown does not care).
 *
 * The whole thing runs in one transaction: a half-applied deletion would leave
 * a user whose matches are already anonymised, which no retry can put back.
 */
export async function deleteUserAccounts(
  prisma: PrismaClient,
  userIds: readonly string[],
  mode: UserDeletionMode = "anonymize"
): Promise<UserDeletionResult> {
  // Never delete the tombstone itself, however it is reached — it is the row
  // every anonymised match points at.
  const requested = [...new Set(userIds)].filter((id) => id !== DELETED_USER_ID);
  if (requested.length === 0) return emptyResult();

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.user.findMany({
        where: { id: { in: requested } },
        select: { id: true },
      });
      const ids = existing.map((u) => u.id);
      if (ids.length === 0) return emptyResult();

      let anonymizedMatches = 0;
      let anonymizedMatchAttempts = 0;
      let purgedMatches = 0;

      if (mode === "anonymize") {
        // Nothing shared to anonymise — a user who never reached a match leaves
        // no row pointing at them, so no tombstone is created for them either.
        const sharedRows =
          (await tx.match.count({
            where: {
              OR: [{ userAId: { in: ids } }, { userBId: { in: ids } }, { proposerId: { in: ids } }],
            },
          })) + (await tx.matchAttempt.count({ where: { userId: { in: ids } } }));

        if (sharedRows > 0) {
          // Created lazily, on the first deletion that needs it — never seeded, so
          // a database that has never deleted anyone has no tombstone row at all.
          // No Profile and no WantedProfile: it cannot be negotiated over, and
          // matchingState IDLE keeps it out of every candidate query, all of which
          // select on WAITING.
          await tx.user.upsert({
            where: { id: DELETED_USER_ID },
            update: {},
            create: {
              id: DELETED_USER_ID,
              email: DELETED_USER_EMAIL,
              name: "Deleted user",
              phone: "",
              gender: "unspecified",
              matchingState: "IDLE",
            },
          });

          const asA = await tx.match.updateMany({
            where: { userAId: { in: ids } },
            data: { userAId: DELETED_USER_ID },
          });
          const asB = await tx.match.updateMany({
            where: { userBId: { in: ids } },
            data: { userBId: DELETED_USER_ID },
          });
          anonymizedMatches = asA.count + asB.count;

          // proposerId is a plain string column, not a relation, so no constraint
          // would have caught it — it would simply dangle (docs/adr/0040).
          await tx.match.updateMany({
            where: { proposerId: { in: ids } },
            data: { proposerId: DELETED_USER_ID },
          });

          const attempts = await tx.matchAttempt.updateMany({
            where: { userId: { in: ids } },
            data: { userId: DELETED_USER_ID },
          });
          anonymizedMatchAttempts = attempts.count;
        }
      } else {
        const matches = await tx.match.findMany({
          where: { OR: [{ userAId: { in: ids } }, { userBId: { in: ids } }] },
          select: { id: true },
        });
        const matchIds = matches.map((m) => m.id);
        // FollowUp and FeedbackRound cascade from User but not from Match, so a
        // purge has to clear them by matchId before the Match rows go.
        await tx.feedbackRound.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.followUp.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.match.deleteMany({ where: { id: { in: matchIds } } });
        purgedMatches = matchIds.length;

        await tx.matchAttempt.deleteMany({ where: { userId: { in: ids } } });
      }

      // Deliberately no relation to User (docs/adr/0039), so no cascade reaches
      // it — but it holds an in-progress interview's answers, so erasure must.
      await tx.interviewSessionSnapshot.deleteMany({ where: { userId: { in: ids } } });

      // Everything still pointing at the user from here cascades: Profile,
      // WantedProfile, PushToken, Notification, SeedTranscript, GoldenPair, and
      // the user's own FollowUp and FeedbackRound.
      await tx.user.deleteMany({ where: { id: { in: ids } } });

      return {
        deletedUserIds: ids,
        anonymizedMatches,
        anonymizedMatchAttempts,
        purgedMatches,
      };
    },
    // The default interactive-transaction timeout is 5s. Nothing here is slow
    // at POC scale, but a purge walks every fixture user's relations in one
    // go — a timeout would abort a teardown mid-seed for no good reason.
    { timeout: TRANSACTION_TIMEOUT_MS }
  );
}

/** Single-user convenience wrapper. Returns false if the id did not exist. */
export async function deleteUserAccount(
  prisma: PrismaClient,
  userId: string,
  mode: UserDeletionMode = "anonymize"
): Promise<boolean> {
  const result = await deleteUserAccounts(prisma, [userId], mode);
  return result.deletedUserIds.length > 0;
}
