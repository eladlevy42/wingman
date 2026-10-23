import { prisma, DELETED_USER_ID } from "@wingman/database";
import type { Match } from "@wingman/database";
import { cooldownMs } from "./orchestration.service";
import { notificationService } from "./notification.service";
import { MatchOwnershipError } from "./match.service";
import { recordEvent } from "./audit.service";

/**
 * The two sides of a match that are actual people.
 *
 * A Match whose departing participant was erased has the deleted-user tombstone
 * on one side (docs/adr/0040). It has no state worth transitioning, no device to
 * notify and nobody to audit, so every per-participant loop iterates this rather
 * than [userAId, userBId] directly.
 */
function participants(match: Match): string[] {
  return [match.userAId, match.userBId].filter((id) => id !== DELETED_USER_ID);
}

// Choose-your-times step (#248, builds on docs/adr/0012). Once both users say
// "yeah" the match enters CHOOSING_TIMES with one participant picked at random
// as the *proposer*: the proposer picks up to three of a shared candidate slate,
// and the other participant (the *chooser*) picks exactly one of those to lock
// in the date. This module owns all venue/slot logic; decision.service drives
// the state machine and delegates the actual scheduling here.

// Fixed, hardcoded Tel Aviv venues (docs/adr/0012) — no geocoding/places API,
// plain code only. The venue is still auto-assigned; only the time is chosen.
export const BLIND_DATE_VENUES = [
  "Aroma Coffee",
  "Anastasia Bar",
  "Container Tel Aviv",
  "Nanuchka",
  "Port Sa'id",
  "Puaa",
  "Shafa Bar",
  "HaBasta",
  "Romano",
  "Beit Kandinof",
] as const;

// How many candidate slots to offer the proposer. Small enough to fit the picker.
export const CANDIDATE_SLOT_COUNT = 5;

// How many of the offered slots the proposer may forward to the chooser.
export const MAX_PROPOSED_SLOTS = 3;

function pickVenue(): string {
  return BLIND_DATE_VENUES[Math.floor(Math.random() * BLIND_DATE_VENUES.length)];
}

// The offered slots are spaced one cooldown-window apart starting two windows
// out, so they scale with the same env-driven clock every other timer uses
// (docs/adr/0012): days apart in prod, minutes apart in dev. Distinct, future,
// and deterministic in spacing — the exact instants don't matter, only that the
// proposer picks from an identical shared set.
export function generateCandidateSlots(now: Date): Date[] {
  return Array.from(
    { length: CANDIDATE_SLOT_COUNT },
    (_, i) => new Date(now.getTime() + (i + 2) * cooldownMs())
  );
}

function parseSlots(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

// Moves a both-yeah match into CHOOSING_TIMES: rolls a random proposer and
// generates the shared candidate slate. Idempotent: if slots were already
// offered this is a no-op, so the resolver can call it on every sweep without
// re-rolling the proposer or the set.
//
// Guarded single UPDATE instead of a JS-level read-then-write (same pattern as
// assignDate/decideMatch): the WHERE clause (candidateSlots still null) is
// evaluated atomically by the database, so two near-simultaneous callers
// (resolveMatchById, fired the instant the second user says Yeah, and the
// background resolver sweep) can't both pass an earlier `match.candidateSlots`
// check and both persist — only the first write wins, and the loser is a
// true no-op instead of re-rolling the proposer and slate (#312).
export async function startTimeSelection(match: Match): Promise<void> {
  if (match.candidateSlots) return;

  const slots = generateCandidateSlots(new Date()).map((d) => d.toISOString());
  const proposerId = Math.random() < 0.5 ? match.userAId : match.userBId;
  const { count } = await prisma.match.updateMany({
    where: { id: match.id, candidateSlots: null },
    data: { candidateSlots: JSON.stringify(slots), proposerId },
  });
  if (count === 0) return;

  await prisma.user.updateMany({
    where: { id: { in: participants(match) } },
    data: { matchingState: "CHOOSING_TIMES" },
  });
  // Both users were MATCHED by construction — only a both-yeah MATCHED match
  // reaches this transition, and the guarded UPDATE above means this runs at
  // most once per match (#552).
  for (const userId of participants(match)) {
    await recordEvent(
      "MATCHING_STATE_CHANGED",
      { from: "MATCHED", to: "CHOOSING_TIMES", trigger: "times_started", matchId: match.id },
      { userId }
    );
  }
}

// Guarded single UPDATE instead of a JS-level read-then-write (same pattern as
// match.service's decideMatch): the WHERE clause (venue still null) is evaluated
// atomically by the database, so two near-simultaneous callers (the background
// sweep and POST /availability) can't both pass an earlier `match.venue` check
// and both persist/notify — only the first write wins, and the loser is a no-op.
// Returns whether this call's write landed, so the caller can tell a pick that
// actually scheduled the date from one the guard discarded (#552).
async function assignDate(match: Match, slotIso: string): Promise<boolean> {
  const venue = pickVenue();
  const dateTime = new Date(slotIso);

  const { count } = await prisma.match.updateMany({
    where: { id: match.id, venue: null },
    data: { venue, dateTime },
  });
  if (count === 0) return false;

  const userIds = participants(match);
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { matchingState: "DATE_ASSIGNED" },
  });
  for (const userId of userIds) {
    await recordEvent(
      "MATCHING_STATE_CHANGED",
      { from: "CHOOSING_TIMES", to: "DATE_ASSIGNED", trigger: "date_assigned", matchId: match.id },
      { userId }
    );
  }
  await Promise.all(
    userIds.map((userId) =>
      notificationService.send(userId, "DATE_ASSIGNED", { matchId: match.id, venue, dateTime })
    )
  );
  return true;
}

export class SlotNotOfferedError extends Error {}
export class MatchNotChoosingTimesError extends Error {}

// Records a time-selection submission. The behaviour depends on the caller's
// role, which is derived from the match's randomly-assigned proposerId:
//   - proposer: stores up to MAX_PROPOSED_SLOTS of the candidate slots for the
//     chooser to pick from (idempotent — a re-submit is discarded), and keeps
//     waiting.
//   - chooser: picks exactly one of the proposer's slots, which locks in the
//     date and flips both users to DATE_ASSIGNED.
export async function submitAvailability(
  matchId: string,
  userId: string,
  slots: string[]
): Promise<{ waiting: boolean; matchingState: string }> {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) throw new MatchNotChoosingTimesError(`No match found for id ${matchId}`);

  if (match.userAId !== userId && match.userBId !== userId) {
    throw new MatchOwnershipError(`User ${userId} is not a participant in match ${matchId}`);
  }

  const candidates = parseSlots(match.candidateSlots);
  if (candidates.length === 0 || !match.proposerId) {
    throw new MatchNotChoosingTimesError(`Match ${matchId} is not choosing times yet`);
  }

  if (match.proposerId === userId) {
    // Proposer: forward up to three of the offered slots. Guarded so a
    // re-submission (double-tap, retry) can't overwrite the first set.
    if (match.proposedSlots) return { waiting: true, matchingState: "CHOOSING_TIMES" };

    const invalid = slots.filter((s) => !candidates.includes(s));
    if (invalid.length > 0) {
      throw new SlotNotOfferedError(
        `Slots not offered for match ${matchId}: ${invalid.join(", ")}`
      );
    }
    const forwarded = slots.slice(0, MAX_PROPOSED_SLOTS);
    const { count: proposedCount } = await prisma.match.updateMany({
      where: { id: matchId, proposedSlots: null },
      data: { proposedSlots: JSON.stringify(forwarded) },
    });
    // Only the write that actually landed is an event — the guarded UPDATE's
    // loser (concurrent re-submit) proposed nothing (#552).
    if (proposedCount > 0) {
      await recordEvent("TIMES_PROPOSED", { matchId, slotCount: forwarded.length }, { userId });
    }
    return { waiting: true, matchingState: "CHOOSING_TIMES" };
  }

  // Chooser: must pick exactly one of the proposer's forwarded slots.
  const proposed = parseSlots(match.proposedSlots);
  if (proposed.length === 0) {
    throw new MatchNotChoosingTimesError(`Match ${matchId}: the proposer has not picked times yet`);
  }
  const choice = slots[0];
  if (!choice || !proposed.includes(choice)) {
    throw new SlotNotOfferedError(
      `Chosen slot is not among the proposed slots for match ${matchId}`
    );
  }
  const landed = await assignDate(match, choice);
  // Same landed-write rule as TIMES_PROPOSED above: if the guard discarded the
  // pick (a double-tap, or the sweep's scheduleFallback got there first), this
  // user's choice scheduled nothing — recording it would credit them with a
  // date the fallback actually chose (#552).
  if (landed) await recordEvent("TIMES_CHOSEN", { matchId }, { userId });
  return { waiting: false, matchingState: "DATE_ASSIGNED" };
}

// Fallback when the decision window expires before the flow completes: schedule
// the earliest slot we can (the proposer's picks if any, else the earliest
// candidate) so a silent user can never strand a mutually-accepted match —
// mirrors decision.service's "non-response is not a veto" resilience. Returns
// false only if there were somehow no slots at all, or the date is already set.
export async function scheduleFallback(matchId: string): Promise<boolean> {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match || match.venue) return false;
  const proposed = parseSlots(match.proposedSlots);
  const candidates = parseSlots(match.candidateSlots);
  const slot = [...proposed].sort()[0] ?? [...candidates].sort()[0] ?? null;
  if (!slot) return false;
  await assignDate(match, slot);
  return true;
}

// Read model for GET /api/users/:id/state while CHOOSING_TIMES: the caller's
// role plus the slots relevant to it — candidateSlots for the proposer to pick
// from, proposedSlots for the chooser to pick from (empty until the proposer
// has picked). hasSubmittedAvailability is true once the proposer has forwarded
// their slots (so their client can show the "waiting on your match" state).
export function timeSelectionView(
  match: Match,
  userId: string
): {
  timeRole: "proposer" | "chooser";
  candidateSlots: string[];
  proposedSlots: string[];
  hasSubmittedAvailability: boolean;
} {
  const isProposer = match.proposerId === userId;
  return {
    timeRole: isProposer ? "proposer" : "chooser",
    candidateSlots: parseSlots(match.candidateSlots),
    proposedSlots: parseSlots(match.proposedSlots),
    hasSubmittedAvailability: isProposer ? match.proposedSlots != null : false,
  };
}
