import { BlindDateResponseSchema, type BlindDateResponse } from "@wingman/shared";
import { apiRequest } from "./api";

/**
 * The confirmed date (docs/adr/0012): venue, time, and the person.
 *
 * Fire-and-forget by design — there is no cancel and no reschedule, so this
 * screen only ever reads.
 */

/**
 * Loads the date. Throws, unlike the reveal: this screen is nothing but these
 * fields, so a failure has to be shown and retried rather than degraded past.
 */
export async function loadBlindDate(userId: string): Promise<BlindDateResponse> {
  return apiRequest(`/api/users/${userId}/blind-date`, {
    schema: BlindDateResponseSchema,
    fallbackErrorMessage: "Could not load your date. Please try again.",
  });
}

/**
 * One warm line about the partner for the date card.
 *
 * First available signal rather than a best one: the card has a slot for a
 * sentence and an empty slot reads as a rendering bug, while any of these three
 * says something true about the person. Null only when the profile carries none
 * of them, and the card then omits the line entirely.
 *
 * Same order and wording as web's, so two people looking at the same date on
 * different clients are told the same thing about each other.
 */
export function personalityBlurb(profile: BlindDateResponse["partnerProfile"]): string | null {
  if (profile.conflict_style) return `Handles conflict ${profile.conflict_style}.`;
  if (profile.emotional_openness) return `${profile.emotional_openness} with feelings.`;
  if (profile.treatment_of_others) return `${profile.treatment_of_others} with people.`;
  return null;
}

/**
 * The subline under the partner's name: age, city and job, in that order,
 * separated by dots. Fields the profile does not carry are dropped rather than
 * leaving an empty gap between separators.
 */
export function partnerSubline(profile: BlindDateResponse["partnerProfile"]): string {
  return [String(profile.age), profile.city, profile.job]
    .filter((part): part is string => part !== null && part.trim() !== "")
    .join(" · ");
}
