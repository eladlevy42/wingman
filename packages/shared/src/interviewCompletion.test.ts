import { describe, expect, it } from "vitest";
import { interviewPhaseCompleted } from "./interviewCompletion";
import type { UserStateResponse } from "./schemas/user";

const state = (overrides: Partial<UserStateResponse> = {}): UserStateResponse =>
  ({ matchingState: "IDLE", hasProfile: false, ...overrides }) as UserStateResponse;

describe("interviewPhaseCompleted", () => {
  describe("interview_self (Phase 1)", () => {
    it("is complete once the profile is persisted", () => {
      expect(interviewPhaseCompleted("interview_self", state({ hasProfile: true }))).toBe(true);
    });

    it("is not complete while there is no profile", () => {
      expect(interviewPhaseCompleted("interview_self", state({ hasProfile: false }))).toBe(false);
    });

    // The stranding case #511 is about: the turn that completed the phase died
    // before `done`, so the client never heard — but the server already knows.
    it("reports completion even though the client saw a failed turn", () => {
      expect(
        interviewPhaseCompleted(
          "interview_self",
          state({ hasProfile: true, matchingState: "IDLE" })
        )
      ).toBe(true);
    });
  });

  describe("interview_wants (Phase 2)", () => {
    it("is not complete while the user is still IDLE", () => {
      expect(
        interviewPhaseCompleted(
          "interview_wants",
          state({ hasProfile: true, matchingState: "IDLE" })
        )
      ).toBe(false);
    });

    it("is complete once completing Phase 2 has moved the user out of IDLE", () => {
      expect(
        interviewPhaseCompleted(
          "interview_wants",
          state({ hasProfile: true, matchingState: "WAITING" })
        )
      ).toBe(true);
    });

    it("does not depend on hasProfile, which is Phase 1's signal", () => {
      expect(
        interviewPhaseCompleted(
          "interview_wants",
          state({ hasProfile: true, matchingState: "MATCHED" })
        )
      ).toBe(true);
    });
  });

  // Pitch must never be reported complete by this predicate — claiming so
  // would move a user on from a decision they have not actually made.
  describe("modes with no onboarding phase", () => {
    it("never reports pitch as complete", () => {
      expect(
        interviewPhaseCompleted("pitch", state({ hasProfile: true, matchingState: "MATCHED" }))
      ).toBe(false);
    });
  });

  // Debrief completion is markDebriefed's transaction (#468): saveFeedback
  // flips the FollowUp to DEBRIEFED and the user back to WAITING together, so
  // followUpState — not matchingState — is the server's statement. Reading
  // matchingState here would be wrong twice over: WAITING alone can't tell a
  // finished debrief from a user who was simply rejected back into the pool.
  describe("debrief", () => {
    it("reports complete once the FollowUp reads DEBRIEFED", () => {
      expect(
        interviewPhaseCompleted(
          "debrief",
          state({ hasProfile: true, matchingState: "WAITING", followUpState: "DEBRIEFED" })
        )
      ).toBe(true);
    });

    it("stays incomplete while the debrief is merely owed", () => {
      expect(
        interviewPhaseCompleted(
          "debrief",
          state({ hasProfile: true, matchingState: "WAITING", followUpState: "DATE_PASSED" })
        )
      ).toBe(false);
      expect(
        interviewPhaseCompleted("debrief", state({ hasProfile: true, matchingState: "WAITING" }))
      ).toBe(false);
    });
  });
});
