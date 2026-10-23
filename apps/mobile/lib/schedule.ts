import {
  SubmitAvailabilityResponseSchema,
  SubmitAvailabilitySchema,
  type SubmitAvailabilityResponse,
} from "@wingman/shared";
import { apiRequest } from "./api";

/**
 * The choose-your-times step (#248, docs/adr/0012).
 *
 * Once both users say yeah, the api rolls one of them at random as the
 * *proposer* and offers a shared slate of candidate slots. The proposer
 * forwards up to three; the *chooser* picks exactly one of those three, and
 * that pick is what writes the venue and flips both users to DATE_ASSIGNED.
 *
 * Nothing here decides anything the server does not already know — the role and
 * both slot lists arrive on `/state`. What lives here is the selection rule and
 * the formatting, the two parts worth testing without a device.
 */

// Mirrors the backend's MAX_PROPOSED_SLOTS (scheduling.service.ts), exactly as
// web's ChooseTimes does — there is still no shared config channel between
// apps/api and the clients. Keep all three in sync.
export const MAX_PROPOSED_SLOTS = 3;

export type TimeRole = "proposer" | "chooser";

/**
 * How many slots this role may select.
 *
 * Anything that is not explicitly the proposer is treated as the chooser,
 * including a role that has not loaded yet. That is the safe direction: the
 * chooser's single pick is the one that locks in a date, and offering three
 * boxes to someone who may only tick one would be a promise the api rejects.
 */
export function maxSelectFor(role: TimeRole | null): number {
  return role === "proposer" ? MAX_PROPOSED_SLOTS : 1;
}

/**
 * The slots this role is choosing between: the whole candidate slate for the
 * proposer, and only what the proposer forwarded for the chooser. Empty for a
 * chooser whose proposer has not picked yet, which is what puts them on the
 * waiting state rather than an empty list.
 */
export function offeredSlots(
  role: TimeRole | null,
  candidateSlots: string[],
  proposedSlots: string[]
): string[] {
  return role === "proposer" ? candidateSlots : proposedSlots;
}

/**
 * Adds or removes a slot from the selection.
 *
 * Tapping a selected slot always deselects it, so nothing can be stuck on. At
 * the limit the behaviour splits, and deliberately: with one pick allowed a new
 * tap *replaces* the old one, because a radio group that silently ignores taps
 * once something is chosen feels broken; with three, a fourth tap is ignored,
 * because there is no single obvious slot to drop. Web's ChooseTimes behaves
 * exactly this way.
 */
export function toggleSlot(selected: string[], iso: string, maxSelect: number): string[] {
  if (selected.includes(iso)) return selected.filter((s) => s !== iso);
  if (maxSelect === 1) return [iso];
  if (selected.length >= maxSelect) return selected;
  return [...selected, iso];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Formats a slot for the picker, in the device's own timezone.
 *
 * Hand-formatted rather than `toLocaleDateString(undefined, {…})`, which is
 * what web uses. Hermes ships a cut-down `Intl`, and the failure mode when it
 * does not understand the options is not an error — it is a differently
 * formatted string. A date the user is being asked to commit to is the wrong
 * place to find that out on a device we cannot check every build of.
 * `formatHeight` is hand-rolled for the same reason.
 */
export function formatSlot(iso: string): { day: string; time: string } {
  const date = new Date(iso);
  const hours = date.getHours();
  const suffix = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return {
    day: `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`,
    time: `${hour12}:${String(date.getMinutes()).padStart(2, "0")} ${suffix}`,
  };
}

/** The same instant on one line, for the confirmed date card. */
export function formatDateTime(iso: string): string {
  const { day, time } = formatSlot(iso);
  return `${day} · ${time}`;
}

/**
 * Submits this user's slot selection.
 *
 * Throws, for the same reason submitDecision does: a selection the user
 * believes they made and the server never received leaves the match stalled
 * until the window expires and the fallback picks a time for them.
 *
 * The response says what the submission did. `DATE_ASSIGNED` means this was the
 * chooser's pick and the date is now set; anything else means the proposer just
 * forwarded their times and is now waiting.
 */
export async function submitAvailability(
  matchId: string | undefined,
  userId: string,
  slots: string[]
): Promise<SubmitAvailabilityResponse> {
  const body = SubmitAvailabilitySchema.parse({ matchId, userId, slots });
  return apiRequest("/api/match/availability", {
    method: "POST",
    body,
    schema: SubmitAvailabilityResponseSchema,
    fallbackErrorMessage: "Could not save your choice. Please try again.",
  });
}
