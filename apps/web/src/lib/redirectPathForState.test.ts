import { describe, it, expect } from "vitest";
import type { UserStateResponse } from "@wingman/shared";
import { redirectPathForState } from "./redirectPathForState";

function state(overrides: Partial<UserStateResponse> = {}): UserStateResponse {
  return { matchingState: "IDLE", hasProfile: false, ...overrides };
}

describe("redirectPathForState", () => {
  // #329: sign-in used to skip the university verification step entirely —
  // verification is the community gate, so it outranks every other route.
  it("routes an unverified user to /authenticate before anything else", () => {
    expect(redirectPathForState(state({ universityVerified: false }))).toBe("/authenticate");
    expect(
      redirectPathForState(
        state({ universityVerified: false, hasProfile: true, matchingState: "WAITING" })
      )
    ).toBe("/authenticate");
  });

  it("routes a verified user without a profile to the Phase 1 interview", () => {
    expect(redirectPathForState(state({ universityVerified: true }))).toBe("/barney/phase1");
  });

  it("keeps matching-state routing for verified users with a profile", () => {
    expect(
      redirectPathForState(
        state({ universityVerified: true, hasProfile: true, matchingState: "WAITING" })
      )
    ).toBe("/waiting");
    expect(
      redirectPathForState(
        state({ universityVerified: true, hasProfile: true, matchingState: "MATCHED" })
      )
    ).toBe("/pitch");
  });

  // #358: a passed date outranks the matchingState mapping — matchingState
  // stays DATE_ASSIGNED after the date, so without this the user parks on
  // /blind-date forever and the debrief never runs.
  it("routes to /debrief once the date has passed", () => {
    expect(
      redirectPathForState(
        state({
          universityVerified: true,
          hasProfile: true,
          matchingState: "DATE_ASSIGNED",
          followUpState: "DATE_PASSED",
        })
      )
    ).toBe("/debrief");
  });

  it("keeps DATE_ASSIGNED routing to /blind-date before the date passes", () => {
    expect(
      redirectPathForState(
        state({
          universityVerified: true,
          hasProfile: true,
          matchingState: "DATE_ASSIGNED",
          followUpState: "AWAITING_DATE",
        })
      )
    ).toBe("/blind-date");
  });

  // The flag is optional in the schema for back-compat with older
  // fixtures/mocks, but the gate is fail-closed: an absent value must route
  // the same as an explicit false, never silently bypass verification.
  it("forces /authenticate when the flag is absent", () => {
    expect(redirectPathForState(state())).toBe("/authenticate");
    expect(redirectPathForState(state({ hasProfile: true, matchingState: "WAITING" }))).toBe(
      "/authenticate"
    );
  });

  describe("the photo gate (#509)", () => {
    const verified = { universityVerified: true, hasProfile: true } as const;

    it("routes a WAITING user with no photo back to Phase 2 for the photo step", () => {
      expect(
        redirectPathForState(state({ ...verified, matchingState: "WAITING", hasPhoto: false }))
      ).toBe("/barney/phase2");
    });

    it("lets a WAITING user with a photo through to /waiting", () => {
      expect(
        redirectPathForState(state({ ...verified, matchingState: "WAITING", hasPhoto: true }))
      ).toBe("/waiting");
    });

    it("sends a REJECTED user with no photo back, since they re-enter the pool", () => {
      expect(
        redirectPathForState(state({ ...verified, matchingState: "REJECTED", hasPhoto: false }))
      ).toBe("/barney/phase2");
    });

    it("does not pull a MATCHED user out of a live match over a missing photo", () => {
      expect(
        redirectPathForState(state({ ...verified, matchingState: "MATCHED", hasPhoto: false }))
      ).toBe("/pitch");
    });

    it("leaves DATE_ASSIGNED alone too", () => {
      expect(
        redirectPathForState(
          state({ ...verified, matchingState: "DATE_ASSIGNED", hasPhoto: false })
        )
      ).toBe("/blind-date");
    });

    it("treats a missing hasPhoto as no reason to bounce anyone", () => {
      expect(
        redirectPathForState(state({ ...verified, matchingState: "WAITING", hasPhoto: undefined }))
      ).toBe("/waiting");
    });

    it("keeps a passed date ahead of the photo gate", () => {
      // The debrief is the feedback loop (#299); a missing photo must not stop
      // a user who already had their date from reaching it.
      expect(
        redirectPathForState(
          state({
            ...verified,
            matchingState: "WAITING",
            hasPhoto: false,
            followUpState: "DATE_PASSED",
          })
        )
      ).toBe("/debrief");
    });
  });
});
