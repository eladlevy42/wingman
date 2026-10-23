import type { BarneyMode } from "./schemas/barney";
import type { UserStateResponse } from "./schemas/user";

/**
 * Whether the server's view of a user says the interview phase a client is
 * currently running has already finished (#511).
 *
 * `phaseComplete` only ever reaches a client on the stream's `done` event. If
 * the stream dies after the deltas but before `done`, and that turn was the one
 * that completed the phase, the api has already persisted the profile and
 * transitioned the user — but the client sees only a failed turn and leaves
 * someone sitting in an interview that is already over.
 *
 * Re-posting does not help: the engine has advanced, and the fallback re-post
 * with the same turnId only returns a cached result while the session is still
 * in the registry. The fix is to stop inferring completion from the stream and
 * ask the server instead, which is what this predicate reads.
 *
 * Lives in `shared` rather than in either client because the two must agree on
 * what "finished" means — a second copy that drifted would strand users on one
 * platform and not the other, which is a correctness risk, not a convenience
 * (CLAUDE.md §3).
 */
export function interviewPhaseCompleted(mode: BarneyMode, state: UserStateResponse): boolean {
  switch (mode) {
    // Phase 1 persists the Profile and flips hasProfile in the same
    // transaction, so hasProfile is the server's statement that it is done.
    case "interview_self":
      return state.hasProfile;
    // Phase 2 flips the user IDLE -> WAITING and starts matching in the same
    // transaction that persists the WantedProfile (persistWantedProfile.ts,
    // docs/adr/0005), so anything other than IDLE means it has completed.
    case "interview_wants":
      return state.matchingState !== "IDLE";
    // Debrief completion is markDebriefed's transaction: saveFeedback firing
    // flips the FollowUp to DEBRIEFED (and the user back to WAITING), so
    // followUpState is the server's statement that the debrief is saved (#468).
    case "debrief":
      return state.followUpState === "DEBRIEFED";
    // Pitch has no phase transition of this shape — its completion is a
    // decision, not an onboarding step, and nothing here should claim it
    // finished.
    case "pitch":
      return false;
  }
}
