import type { UserStateResponse } from "@wingman/shared";

// The routes this slice actually ships. Kept as a const map so a typo in a
// screen becomes a type error rather than a silent navigation to nowhere.
export const ROUTES = {
  // The boot screen (app/index.tsx). It re-derives the right destination from
  // the api, and owns the "Can't reach Wingman / Try again" state — which makes
  // it the right place to send anyone whose own state lookup failed.
  boot: "/",
  register: "/register",
  login: "/login",
  verify: "/verify",
  verified: "/verified",
  phase1: "/barney/phase1",
  phase2: "/barney/phase2",
  waiting: "/waiting",
  pitch: "/pitch",
  chooseTimes: "/choose-times",
  blindDate: "/blind-date",
  // Guarded by the screen itself, not by routeForMatchingState: debrief entry
  // depends on followUpState (DATE_PASSED), which matchingState alone cannot
  // express — mirroring how web's Debrief.tsx gates itself (#468).
  debrief: "/debrief",
} as const;

export type Route = (typeof ROUTES)[keyof typeof ROUTES];

// Where a user belongs based on matchingState alone, once onboarding is out of
// the picture. Mobile counterpart of the web's redirectPathForMatchingState.
//
// IDLE is the one state that means "Phase 2 has not happened yet": completing
// the wants interview flips the user to WAITING in the same transaction that
// persists the WantedProfile (persistWantedProfile.ts, docs/adr/0005), so an
// IDLE user with a saved Phase 1 profile still owes us Phase 2.
//
// A user missing their photo is sent to phase2 by routeForState before this is
// consulted, so "phase2" here still means only "the wants interview is owed".
//
// WAITING and REJECTED both land on the waiting screen (#439), matching web's
// redirectPathForMatchingState exactly: a rejected user is back in the pool for
// the next cycle, which is the same thing the waiting screen is for.
//
// MATCHED lands on the pitch screen: the reveal (#462), the genie chat (#463)
// and the Yeah/Nah decision (#464).
//
// Every matching state now has a screen of its own, and the pending placeholder
// that used to absorb the last two is gone with it (#465).
//
// The three post-match states share a property the earlier ones do not: a user
// leaves them without navigating themselves. Saying yeah moves them to
// CHOOSING_TIMES once the other side agrees; the chooser picking a time moves
// both to DATE_ASSIGNED. Those transitions happen on the server, so each of
// those screens watches its own state rather than trusting the mount-time guard
// that got it there. See useGuardedRoute's note on screens that stay mounted
// across a state change.
//
// DATE_ASSIGNED is where this mapping ends: once the date passes, the debrief
// (#467/#468) takes over — but that turns on followUpState, which matchingState
// alone cannot express, so routeForState handles it above this mapping.
//
// Split out from routeForState because Phase 2 needs it on its own: the screen
// re-checks matchingState before starting a session, so a user who already
// finished the wants interview (back gesture, relaunch, a second device) is
// redirected instead of being walked through it again.
export function routeForMatchingState(matchingState: UserStateResponse["matchingState"]): Route {
  if (matchingState === "IDLE") return ROUTES.phase2;
  if (matchingState === "WAITING" || matchingState === "REJECTED") return ROUTES.waiting;
  if (matchingState === "MATCHED") return ROUTES.pitch;
  if (matchingState === "CHOOSING_TIMES") return ROUTES.chooseTimes;
  return ROUTES.blindDate;
}

// Mobile counterpart of the web's redirectPathForState (apps/web/src/lib).
// Onboarding order is identical and deliberately so — the two clients talk to
// the same api and must agree on where a given user belongs:
//
//   not university-verified -> verify   (the community gate, #329)
//   no profile yet          -> phase 1  (the "grill me" interview)
//   profile, still IDLE     -> phase 2  (the "what you're looking for" interview)
//   in the matching pool    -> waiting  (WAITING / REJECTED)
//   matched                 -> pitch
//   both said yeah          -> choose-times
//   date set                -> blind date
//   date passed             -> debrief
//
// Fail-closed on universityVerified, exactly as web does: anything other than an
// explicit `true` (including the field being absent) forces the verify detour,
// so a response that omits the optional flag cannot silently open the gate.
// The matching-pool states — the ones where a missing photo is still worth
// going back for. Completing Phase 2 flips the user to WAITING and starts
// matching in the same transaction, and only then is the photo uploaded, so
// anyone killed in that gap sits in the pool photoless (#509).
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

export function routeForState(state: UserStateResponse): Route {
  if (state.universityVerified !== true) return ROUTES.verify;
  if (!state.hasProfile) return ROUTES.phase1;
  // A passed date outranks the matchingState mapping, as on web (#358):
  // matchingState stays DATE_ASSIGNED after the date happens, so without this
  // branch the user parks on the date card forever and the debrief — the
  // feedback loop — only ever opens from a push tap. Requires matchId because
  // the debrief screen bounces a matchId-less state back through this function,
  // and answering /debrief for it would ping-pong the two.
  if (state.followUpState === "DATE_PASSED" && state.matchId) return ROUTES.debrief;
  // Only an explicit false — see the schema note on hasPhoto for why this one
  // reads the opposite way round to universityVerified above.
  if (state.hasPhoto === false && AWAITING_MATCH.has(state.matchingState)) return ROUTES.phase2;
  return routeForMatchingState(state.matchingState);
}

/**
 * Where a guarded screen should send whoever just opened it — or that they may
 * stay. `expected` is the route routeForState returns for the state the screen
 * is for, so onboarding order is decided in exactly one place.
 *
 * `state` is null when the api could not be reached: the stored session says
 * who someone is, but only the server knows how far they have got, and guessing
 * that wrong is what overwrote a finished profile (#497). Hand those off to the
 * boot screen, which makes the same call and owns the retry state, rather than
 * letting the screen through unchecked.
 *
 * Pure so the policy is testable without a renderer — the hook that consumes it
 * (useGuardedRoute) only does the awaiting and the navigating.
 */
export type GuardOutcome = { allowed: true; userId: string } | { allowed: false; to: Route };

export function guardOutcome(
  expected: Route,
  user: { id: string } | null,
  state: UserStateResponse | null
): GuardOutcome {
  if (!user) return { allowed: false, to: ROUTES.login };
  if (!state) return { allowed: false, to: ROUTES.boot };
  const destination = routeForState(state);
  if (destination !== expected) return { allowed: false, to: destination };
  return { allowed: true, userId: user.id };
}
