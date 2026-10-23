import { describe, expect, it } from "vitest";
import type { UserStateResponse } from "@wingman/shared";
import { ROUTES, guardOutcome, routeForMatchingState, routeForState } from "./routeForState";

function state(overrides: Partial<UserStateResponse> = {}): UserStateResponse {
  return { matchingState: "IDLE", hasProfile: false, universityVerified: true, ...overrides };
}

describe("routeForState", () => {
  it("sends an unverified user to the university gate", () => {
    expect(routeForState(state({ universityVerified: false }))).toBe(ROUTES.verify);
  });

  it("treats a missing universityVerified flag as unverified", () => {
    // Fail-closed: a response that omits the optional field must not be able to
    // walk straight past the community gate.
    expect(routeForState(state({ universityVerified: undefined }))).toBe(ROUTES.verify);
  });

  it("keeps the gate ahead of the interview even once a profile exists", () => {
    expect(routeForState(state({ universityVerified: false, hasProfile: true }))).toBe(
      ROUTES.verify
    );
  });

  it("sends a verified user with no profile into Phase 1", () => {
    expect(routeForState(state({ hasProfile: false }))).toBe(ROUTES.phase1);
  });

  it("does not send a user back through the interview they already finished", () => {
    // Phase 1 is behind them, so the next thing owed is Phase 2 — not Phase 1
    // again.
    expect(routeForState(state({ hasProfile: true }))).toBe(ROUTES.phase2);
  });

  it("sends a user with a profile who is still IDLE into Phase 2", () => {
    expect(routeForState(state({ hasProfile: true, matchingState: "IDLE" }))).toBe(ROUTES.phase2);
  });

  // The pool got its own screen in #439. A REJECTED user is back in it for the
  // next cycle, which is the same thing the waiting screen is for — matching
  // web's redirectPathForMatchingState exactly.
  it("sends everyone in the matching pool to the waiting screen", () => {
    const states: UserStateResponse["matchingState"][] = ["WAITING", "REJECTED"];
    for (const matchingState of states) {
      expect(routeForState(state({ hasProfile: true, matchingState }))).toBe(ROUTES.waiting);
    }
  });

  it("sends a matched user to the pitch", () => {
    expect(routeForState(state({ hasProfile: true, matchingState: "MATCHED" }))).toBe(ROUTES.pitch);
  });

  // Slice 4 gave the last three states screens of their own, which is what
  // retired the pending placeholder — nothing routes there any more, so the
  // screen went with it.
  it("sends a both-yeah pair to choose their times", () => {
    expect(routeForState(state({ hasProfile: true, matchingState: "CHOOSING_TIMES" }))).toBe(
      ROUTES.chooseTimes
    );
  });

  it("sends a scheduled pair to the date card", () => {
    expect(routeForState(state({ hasProfile: true, matchingState: "DATE_ASSIGNED" }))).toBe(
      ROUTES.blindDate
    );
  });

  it("gives every matching state a screen of its own", () => {
    const states: UserStateResponse["matchingState"][] = [
      "IDLE",
      "WAITING",
      "MATCHED",
      "CHOOSING_TIMES",
      "REJECTED",
      "DATE_ASSIGNED",
    ];
    const destinations = states.map((matchingState) =>
      routeForState(state({ hasProfile: true, matchingState }))
    );
    // WAITING and REJECTED deliberately share the pool screen; everything else
    // is distinct. Five destinations for six states.
    expect(new Set(destinations).size).toBe(5);
  });

  // #467/#468: matchingState stays DATE_ASSIGNED after the date happens, so a
  // passed date has to outrank the matchingState mapping — otherwise the only
  // door into the debrief is the push notification, and anyone who dismissed it
  // parks on the date card forever. Same precedence as web (#358).
  describe("a passed date", () => {
    it("routes to the debrief instead of parking on the date screen", () => {
      expect(
        routeForState(
          state({
            hasProfile: true,
            matchingState: "DATE_ASSIGNED",
            followUpState: "DATE_PASSED",
            matchId: "m-1",
          })
        )
      ).toBe(ROUTES.debrief);
    });

    it("does not claim the debrief without a matchId to debrief about", () => {
      // The debrief screen bounces a matchId-less state back through
      // routeForState — answering /debrief here would ping-pong the two.
      expect(
        routeForState(
          state({ hasProfile: true, matchingState: "DATE_ASSIGNED", followUpState: "DATE_PASSED" })
        )
      ).toBe(ROUTES.blindDate);
    });

    it("stays behind the university and profile gates", () => {
      const passed = {
        matchingState: "DATE_ASSIGNED" as const,
        followUpState: "DATE_PASSED" as const,
        matchId: "m-1",
      };
      expect(routeForState(state({ ...passed, universityVerified: false, hasProfile: true }))).toBe(
        ROUTES.verify
      );
      expect(routeForState(state({ ...passed, hasProfile: false }))).toBe(ROUTES.phase1);
    });

    it("no longer claims the debrief once the user has debriefed", () => {
      // markDebriefed flips followUpState to DEBRIEFED and the user back to
      // WAITING in one transaction — the waiting screen is where they belong.
      expect(
        routeForState(
          state({
            hasProfile: true,
            matchingState: "WAITING",
            followUpState: "DEBRIEFED",
            matchId: "m-1",
          })
        )
      ).toBe(ROUTES.waiting);
    });
  });

  describe("the photo gate (#509)", () => {
    it("sends a WAITING user with no photo back to the photo step", () => {
      // The gap this closes: completing Phase 2 flips the user to WAITING
      // server-side, and the upload is a separate call afterwards. Killed in
      // between, they used to route straight past the photo forever.
      expect(
        routeForState(state({ hasProfile: true, matchingState: "WAITING", hasPhoto: false }))
      ).toBe(ROUTES.phase2);
    });

    it("lets a WAITING user with a photo through to the waiting screen", () => {
      expect(
        routeForState(state({ hasProfile: true, matchingState: "WAITING", hasPhoto: true }))
      ).toBe(ROUTES.waiting);
    });

    it("sends a REJECTED user with no photo back, since they re-enter the pool", () => {
      expect(
        routeForState(state({ hasProfile: true, matchingState: "REJECTED", hasPhoto: false }))
      ).toBe(ROUTES.phase2);
    });

    it("does not pull a MATCHED user out of a live match over a missing photo", () => {
      // Worse failure than the missing photo: the Reveal already degrades
      // gracefully because getMatchPhoto answers null rather than erroring.
      expect(
        routeForState(state({ hasProfile: true, matchingState: "MATCHED", hasPhoto: false }))
      ).toBe(ROUTES.pitch);
    });

    it("leaves DATE_ASSIGNED alone too", () => {
      expect(
        routeForState(state({ hasProfile: true, matchingState: "DATE_ASSIGNED", hasPhoto: false }))
      ).toBe(ROUTES.blindDate);
    });

    it("treats a missing hasPhoto as no reason to bounce anyone", () => {
      // The opposite reading to universityVerified, deliberately: failing
      // closed here would trap users who do have a photo on a screen asking
      // for one they already gave.
      expect(
        routeForState(state({ hasProfile: true, matchingState: "WAITING", hasPhoto: undefined }))
      ).toBe(ROUTES.waiting);
    });

    it("keeps the university gate ahead of the photo gate", () => {
      expect(
        routeForState(
          state({
            universityVerified: false,
            hasProfile: true,
            matchingState: "WAITING",
            hasPhoto: false,
          })
        )
      ).toBe(ROUTES.verify);
    });
  });
});

describe("routeForMatchingState", () => {
  // This is the Phase 2 re-entry guard. IDLE is the only state that still owes
  // us the wants interview: completing it flips the user to WAITING in the same
  // transaction that saves the WantedProfile, so anything else means Phase 2 is
  // already behind them and re-running it would overwrite a finished profile.
  it("keeps an IDLE user on Phase 2", () => {
    expect(routeForMatchingState("IDLE")).toBe(ROUTES.phase2);
  });

  it("redirects away from Phase 2 for every state that has passed it", () => {
    const states: UserStateResponse["matchingState"][] = [
      "WAITING",
      "MATCHED",
      "CHOOSING_TIMES",
      "REJECTED",
      "DATE_ASSIGNED",
    ];
    for (const matchingState of states) {
      expect(routeForMatchingState(matchingState)).not.toBe(ROUTES.phase2);
    }
  });

  it("sends the pool states to the waiting screen", () => {
    expect(routeForMatchingState("WAITING")).toBe(ROUTES.waiting);
    expect(routeForMatchingState("REJECTED")).toBe(ROUTES.waiting);
  });

  it("sends a matched user to the pitch", () => {
    expect(routeForMatchingState("MATCHED")).toBe(ROUTES.pitch);
  });
});

const USER = { id: "user-1" };

/**
 * #497: two related gaps, both of which came down to a screen deciding for
 * itself who it was for. `/verified` and the old `/pending` asked nothing at all and
 * rendered in full to a visitor with no session — telling a signed-out stranger
 * "Your profile is saved". `/barney/phase1` asked only whether *a* user was
 * stored, so someone who had already finished Phase 1 was handed a fresh
 * interview from question one, and finishing it overwrote their existing
 * structuredData through saveProfile's upsert.
 *
 * guardOutcome moves that decision to the one place that already knows the
 * onboarding order, and asks the api rather than local storage.
 */
describe("guardOutcome", () => {
  it("sends a visitor with no session to sign-in", () => {
    expect(guardOutcome(ROUTES.blindDate, null, null)).toEqual({
      allowed: false,
      to: ROUTES.login,
    });
  });

  it("sends a visitor with no session away from /verified too", () => {
    // The screen that used to greet them with "You're Verified".
    expect(guardOutcome(ROUTES.phase1, null, state())).toEqual({
      allowed: false,
      to: ROUTES.login,
    });
  });

  it("lets a user through to the screen their state calls for", () => {
    expect(guardOutcome(ROUTES.phase1, USER, state({ hasProfile: false }))).toEqual({
      allowed: true,
      userId: USER.id,
    });
  });

  // The one that costs data: a completed profile must never be handed a fresh
  // interview, because completing it upserts over the old structuredData.
  //
  // Since #438 the destination is /barney/phase2 rather than the old /pending — an
  // IDLE user with a saved profile still owes us the wants interview. What this
  // test pins is unchanged and is the part that matters: they are turned away
  // from Phase 1. Where they go instead is routeForState's business, and is
  // covered above.
  it("turns a user with a completed profile away from the interview", () => {
    expect(guardOutcome(ROUTES.phase1, USER, state({ hasProfile: true }))).toEqual({
      allowed: false,
      to: ROUTES.phase2,
    });
  });

  // The same guard one slice later: once Phase 2 is done the user is WAITING,
  // and since #439 /waiting is where they belong — so the guard must stop
  // redirecting them onward or they would bounce between two screens.
  it("lets a user who has finished Phase 2 settle on /waiting", () => {
    expect(
      guardOutcome(ROUTES.waiting, USER, state({ hasProfile: true, matchingState: "WAITING" }))
    ).toEqual({ allowed: true, userId: USER.id });
  });

  // And the converse for the screens further down the flow: a stale push must
  // not leave someone on a date card belonging to a match they are no longer
  // in. Both post-match screens have to turn a pooled user away.
  it("turns a user still in the matching pool away from the date card", () => {
    expect(
      guardOutcome(ROUTES.blindDate, USER, state({ hasProfile: true, matchingState: "WAITING" }))
    ).toEqual({ allowed: false, to: ROUTES.waiting });
  });

  it("turns a user still in the matching pool away from choose-times", () => {
    expect(
      guardOutcome(ROUTES.chooseTimes, USER, state({ hasProfile: true, matchingState: "WAITING" }))
    ).toEqual({ allowed: false, to: ROUTES.waiting });
  });

  it("lets a both-yeah pair through to choose their times", () => {
    expect(
      guardOutcome(
        ROUTES.chooseTimes,
        USER,
        state({ hasProfile: true, matchingState: "CHOOSING_TIMES" })
      )
    ).toEqual({ allowed: true, userId: USER.id });
  });

  it("lets a scheduled pair through to the date card", () => {
    expect(
      guardOutcome(
        ROUTES.blindDate,
        USER,
        state({ hasProfile: true, matchingState: "DATE_ASSIGNED" })
      )
    ).toEqual({ allowed: true, userId: USER.id });
  });

  // The one that would strand someone mid-flow: the chooser locking in a date
  // moves both users on, and the proposer still sitting on choose-times has to
  // follow rather than keep offering times for a date that is already set.
  it("moves a proposer off choose-times once the date is set", () => {
    expect(
      guardOutcome(
        ROUTES.chooseTimes,
        USER,
        state({ hasProfile: true, matchingState: "DATE_ASSIGNED" })
      )
    ).toEqual({ allowed: false, to: ROUTES.blindDate });
  });

  it("turns a user who still owes Phase 2 away from /waiting", () => {
    expect(
      guardOutcome(ROUTES.waiting, USER, state({ hasProfile: true, matchingState: "IDLE" }))
    ).toEqual({ allowed: false, to: ROUTES.phase2 });
  });

  it("turns a matched user away from /waiting", () => {
    expect(
      guardOutcome(ROUTES.waiting, USER, state({ hasProfile: true, matchingState: "MATCHED" }))
    ).toEqual({ allowed: false, to: ROUTES.pitch });
  });

  it("lets a matched user through to the pitch", () => {
    expect(
      guardOutcome(ROUTES.pitch, USER, state({ hasProfile: true, matchingState: "MATCHED" }))
    ).toEqual({ allowed: true, userId: USER.id });
  });

  // The pitch is the first guarded screen a user leaves without navigating:
  // once both sides say yeah the server moves them to CHOOSING_TIMES. The
  // mount-time guard cannot see that happen — it only stops someone who arrives
  // at /pitch with no live match, which is what a stale push or a back gesture
  // after the decision produces.
  it("turns a user with no live match away from the pitch", () => {
    expect(
      guardOutcome(ROUTES.pitch, USER, state({ hasProfile: true, matchingState: "WAITING" }))
    ).toEqual({ allowed: false, to: ROUTES.waiting });
  });

  it("keeps the university gate ahead of the pitch too", () => {
    expect(
      guardOutcome(
        ROUTES.pitch,
        USER,
        state({ universityVerified: false, hasProfile: true, matchingState: "MATCHED" })
      )
    ).toEqual({ allowed: false, to: ROUTES.verify });
  });

  // The photo gate still outranks the waiting screen: someone killed between
  // finishing Phase 2 and uploading sits in the pool photoless (#509).
  it("keeps the photo gate ahead of the waiting screen", () => {
    expect(
      guardOutcome(
        ROUTES.waiting,
        USER,
        state({ hasProfile: true, matchingState: "WAITING", hasPhoto: false })
      )
    ).toEqual({ allowed: false, to: ROUTES.phase2 });
  });

  // And the converse: a post-match screen must bounce a user who still owes us
  // Phase 2, which is the case #438 introduced and this guard has to respect.
  it("turns a user who still owes Phase 2 away from the date card", () => {
    expect(
      guardOutcome(ROUTES.blindDate, USER, state({ hasProfile: true, matchingState: "IDLE" }))
    ).toEqual({ allowed: false, to: ROUTES.phase2 });
  });

  it("turns a user without a profile away from the post-match screens", () => {
    expect(guardOutcome(ROUTES.blindDate, USER, state({ hasProfile: false }))).toEqual({
      allowed: false,
      to: ROUTES.phase1,
    });
  });

  it("keeps the university gate ahead of everything", () => {
    expect(guardOutcome(ROUTES.phase1, USER, state({ universityVerified: false }))).toEqual({
      allowed: false,
      to: ROUTES.verify,
    });
    expect(
      guardOutcome(ROUTES.blindDate, USER, state({ universityVerified: false, hasProfile: true }))
    ).toEqual({ allowed: false, to: ROUTES.verify });
  });

  // Fail-closed on an unreachable api. A stored session says who someone is,
  // but only the server knows how far they have got — and this guard exists
  // because guessing that wrong is what loses a profile.
  it("sends a user whose state could not be read to the boot screen", () => {
    expect(guardOutcome(ROUTES.phase1, USER, null)).toEqual({
      allowed: false,
      to: ROUTES.boot,
    });
  });

  it("never lets an unreachable api open the interview", () => {
    const outcome = guardOutcome(ROUTES.phase1, USER, null);
    expect(outcome.allowed).toBe(false);
  });
});
