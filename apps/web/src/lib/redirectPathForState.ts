import type { UserStateResponse } from "@wingman/shared";

// Where a user should land based on matchingState alone, once Phase 1/2
// onboarding is out of the picture. IDLE means Phase 2 is still pending.
// REJECTED users wait for the next matching cycle.
export function redirectPathForMatchingState(
  matchingState: UserStateResponse["matchingState"]
): string {
  if (matchingState === "WAITING") return "/waiting";
  if (matchingState === "MATCHED") return "/pitch";
  if (matchingState === "CHOOSING_TIMES") return "/choose-times";
  if (matchingState === "DATE_ASSIGNED") return "/blind-date";
  return matchingState === "REJECTED" ? "/waiting" : "/barney/phase2";
}

// The matching-pool states — the ones where a missing photo is still worth
// going back for. Completing Phase 2 flips the user to WAITING and starts
// matching in the same transaction, and only then is the photo uploaded, so
// anyone who closes the tab in that gap sits in the pool photoless (#509).
//
// Deliberately excludes MATCHED, CHOOSING_TIMES and DATE_ASSIGNED: pulling
// someone out of a live match to ask for a photo is a worse failure than the
// missing photo itself, and the Reveal already degrades gracefully — the api's
// getMatchPhoto answers a null photoUrl rather than an error precisely so the
// decision is never blocked on it.
const AWAITING_MATCH: ReadonlySet<UserStateResponse["matchingState"]> = new Set([
  "IDLE",
  "WAITING",
  "REJECTED",
]);

// Maps the user's onboarding progress and matching state to the screen they
// should land on. Onboarding takes precedence; matching state drives the rest.
// See docs/adr/0002.
export function redirectPathForState(state: UserStateResponse): string {
  // University verification is the community gate — it comes before everything
  // else (#329). Fail-closed: anything other than an explicit true (including
  // the flag being absent) forces the detour, so a response that omits the
  // optional field can't silently bypass verification.
  if (state.universityVerified !== true) return "/authenticate";
  if (!state.hasProfile) return "/barney/phase1";
  // A passed date outranks the matchingState mapping (#358): matchingState
  // stays DATE_ASSIGNED after the date happens, so without this branch the
  // user parks on "It's a date." forever and the debrief (the feedback loop,
  // #299) never runs. Debrief.tsx only auto-starts on DATE_PASSED, so this
  // can never route someone in too early.
  if (state.followUpState === "DATE_PASSED") return "/debrief";
  // Only an explicit false — see the schema note on hasPhoto for why this one
  // reads the opposite way round to universityVerified above (#509).
  if (state.hasPhoto === false && AWAITING_MATCH.has(state.matchingState)) {
    return "/barney/phase2";
  }
  // TODO(#27): once the WantedProfile table lands, a hasProfile user who is
  // still IDLE may have already finished Phase 2 — route on Phase 2 completion
  // rather than assuming IDLE means "not started". For now, completing Phase 2
  // flips matchingState to WAITING, so IDLE reliably means Phase 2 is pending.
  return redirectPathForMatchingState(state.matchingState);
}
