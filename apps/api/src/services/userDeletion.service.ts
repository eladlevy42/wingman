import bcrypt from "bcryptjs";
import { prisma, deleteUserAccount } from "@wingman/database";
import type { Match } from "@wingman/database";
import { DeleteAccountRequestSchema } from "@wingman/shared";
import { NotFoundError, InvalidCredentialsError } from "./user.service";
import { rejectMatch } from "./decision.service";
import { recordEvent } from "./audit.service";
import { deleteAuditDataForUser } from "./auditRetention.service";

/**
 * Account erasure (#561). The domain-row teardown itself lives in
 * @wingman/database — seedFixtures.ts needs the same path and cannot import
 * from apps/api — so this service is the part only the api owns: the
 * credential check, the 404, releasing the counterparty of any date that will
 * now never happen, the audit event, and the audit-table erasure.
 *
 * Order is deliberate (docs/adr/0040): check, record, release, erase the domain
 * rows, then erase the audit rows — which takes the USER_DELETED event with
 * them. The event exists only for the duration of the request, so a crash
 * mid-erasure leaves a trace of what was attempted and a completed one leaves
 * nothing keyed by the departed userId.
 */
export async function deleteUser(userId: string, input: unknown): Promise<void> {
  const { password } = DeleteAccountRequestSchema.parse(input);

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!existing) throw new NotFoundError("User not found");

  // Deletion is irreversible and a user id is not a secret — /:id/state hands a
  // caller their match's id — so the account password is the gate. The null
  // check mirrors loginUser: a passwordless row (left by the removed social
  // sign-in, #512) fails the credential check rather than making bcrypt throw.
  if (!existing.passwordHash || !(await bcrypt.compare(password, existing.passwordHash))) {
    throw new InvalidCredentialsError("Incorrect password");
  }

  await recordEvent("USER_DELETED", {}, { userId });

  await releaseCounterparties(userId);

  const deleted = await deleteUserAccount(prisma, userId);

  // Runs whichever way the domain delete went. A row that vanished between the
  // check above and the delete is still a user whose audit trail must go, and
  // deleteMany is a no-op when it matches nothing.
  await eraseAuditTrail(userId);

  // False means the row went between the check above and the delete, or the id
  // is the tombstone itself — which deleteUserAccounts refuses, and which is not
  // a person to delete. Both answer 404.
  if (!deleted) throw new NotFoundError("User not found");
}

/**
 * Cancels every match of the departing user whose date has not happened yet,
 * releasing the other participant back into matching.
 *
 * Without this the counterparty is left holding a live match against a
 * tombstone that can never answer Yeah/Nah, never pick a time and never show
 * up: at DATE_ASSIGNED nothing moves them again at all, and before that they
 * wait out the full decision window first. Rejection is the transition the rest
 * of the app already understands — decision.service's own path, so the
 * counterparty's client sees the same WAITING it sees for any other rejection,
 * with no new vocabulary and no new screen.
 *
 * A match whose date has already happened is left exactly as it is: it is the
 * counterparty's record of a real date (docs/adr/0040), and their debrief — the
 * feedback that tunes their next match — still has to be possible afterwards.
 */
async function releaseCounterparties(userId: string): Promise<void> {
  const now = new Date();
  const upcoming: Match[] = await prisma.match.findMany({
    where: {
      status: "MATCHED",
      AND: [
        { OR: [{ userAId: userId }, { userBId: userId }] },
        { OR: [{ dateTime: null }, { dateTime: { gt: now } }] },
      ],
    },
  });

  for (const match of upcoming) {
    await rejectMatch(match);
  }
}

/**
 * Erases the audit rows, loudly.
 *
 * This is the one step outside the domain teardown's transaction, so a failure
 * here leaves a person whose domain rows are gone and whose audit trail is not
 * — the exact inversion of ADR-0038's erasure promise. It must never be
 * swallowed: the log names the userId so the erasure can be completed by hand,
 * and the throw surfaces it as a 500 rather than a 204 that lied.
 */
async function eraseAuditTrail(userId: string): Promise<void> {
  try {
    await deleteAuditDataForUser(userId);
  } catch (error) {
    console.error(
      `userDeletion: domain rows for ${userId} are erased but their audit rows are NOT — ` +
        `re-run deleteAuditDataForUser("${userId}") to finish the erasure:`,
      error
    );
    throw error;
  }
}
