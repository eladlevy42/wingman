import { prisma, DELETED_USER_ID } from "@wingman/database";
import type { Match } from "@wingman/database";
import { cooldownMs, decisionWindowMs } from "./orchestration.service";
import { notificationService } from "./notification.service";
import { recordEvent } from "./audit.service";

// The reminder window follows the human clock (DECISION_WINDOW_MINUTES —
// #302, docs/adr/0024): it's a "give the human time" wait, like the Yeah/Nah
// window, not a sweep cadence. The sweep itself stays on cooldownMs().
// One invariant survives from before #302: the window can never be narrower
// than the sweep's own cadence, or a slow sweep would step over it entirely
// (tick lands "too early", next tick lands after the date — PRE_DATE_REMINDER
// never fires). Hence the Math.max: a short decision window widens back to
// one full cooldown here. Cost is exactness, as before: at prod cadences this
// fires "on the last sweep before the date" rather than at a precise offset.
function reminderWindowMs(): number {
  return Math.max(decisionWindowMs(), cooldownMs());
}

// In-memory de-dupe so a reminder fires once per FollowUp row rather than on
// every tick for the whole window — no schema field for this since the issue
// spec pins FollowUp's columns to id/userId/matchId/state. Resets on restart,
// which is harmless: a missed/duplicate reminder is not safety-critical here.
const remindedFollowUpIds = new Set<string>();

async function processUserFollowUp(userId: string, match: Match): Promise<void> {
  const followUp = await prisma.followUp.upsert({
    where: { userId_matchId: { userId, matchId: match.id } },
    create: { userId, matchId: match.id, state: "AWAITING_DATE" },
    update: {},
  });

  if (followUp.state !== "AWAITING_DATE" || !match.dateTime) return;

  const now = Date.now();
  const dateTime = match.dateTime.getTime();

  if (now >= dateTime) {
    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { state: "DATE_PASSED" },
    });
    await notificationService.send(userId, "DEBRIEF_NUDGE", { matchId: match.id });
    return;
  }

  if (dateTime - now <= reminderWindowMs() && !remindedFollowUpIds.has(followUp.id)) {
    remindedFollowUpIds.add(followUp.id);
    await notificationService.send(userId, "PRE_DATE_REMINDER", { matchId: match.id });
  }
}

// Advances a FollowUp to its terminal state once the user's debrief session
// has actually persisted feedback (#75) — the only other writer of this row
// (processUserFollowUp above) only ever reaches DATE_PASSED, so without this
// call DEBRIEFED would never be set and a user could be re-nudged forever.
// Also resets the user's matchingState back to WAITING (#77) — matching.service
// only considers WAITING users, and decision.service.ts never moves a user off
// DATE_ASSIGNED, so without this a debriefed user would be stuck forever and
// /waiting would keep bouncing them back to /blind-date.
export async function markDebriefed(userId: string, matchId: string): Promise<void> {
  await prisma.followUp.update({
    where: { userId_matchId: { userId, matchId } },
    data: { state: "DEBRIEFED" },
  });
  // enteredWaitingAt is reset here so the sweep's fairness ordering (#343)
  // reflects this re-entry, not the account's original createdAt.
  await prisma.user.update({
    where: { id: userId },
    data: { matchingState: "WAITING", enteredWaitingAt: new Date() },
  });
  await recordEvent("DEBRIEF_COMPLETED", { matchId }, { userId });
  // A debriefing user is DATE_ASSIGNED by construction — the debrief session
  // only opens on a DATE_PASSED FollowUp, which requires an assigned date.
  await recordEvent(
    "MATCHING_STATE_CHANGED",
    { from: "DATE_ASSIGNED", to: "WAITING", trigger: "debrief_completed", matchId },
    { userId }
  );
}

let isRunning = false;

// One follow-up sweep: every Match with an assigned Blind Date gets a
// FollowUp row lazily created (if missing) for each of its two users, then
// checked against the reminder/nudge rules above. A failure for one user does
// not stop the rest of the sweep. Skips entirely if the previous sweep is
// still running rather than overlapping with it.
export async function runFollowUpTick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const assignedMatches = await prisma.match.findMany({
      where: { status: "MATCHED", dateTime: { not: null } },
    });

    for (const match of assignedMatches) {
      for (const userId of [match.userAId, match.userBId]) {
        // The deleted-user tombstone is one side of any match whose participant
        // erased their account (docs/adr/0040). processUserFollowUp UPSERTS a
        // FollowUp row and sends notifications, so without this the sweep would
        // recreate, for a deleted user, exactly the rows the erasure removed.
        if (userId === DELETED_USER_ID) continue;
        try {
          await processUserFollowUp(userId, match);
        } catch (error) {
          console.error(`followup: failed to process user ${userId} for match ${match.id}:`, error);
        }
      }
    }
  } finally {
    isRunning = false;
  }
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;

export function startFollowUpLoop(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runFollowUpTick();
  }, cooldownMs());
}

export function stopFollowUpLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
