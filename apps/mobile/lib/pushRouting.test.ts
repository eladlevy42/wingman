import { describe, expect, it } from "vitest";
import { routeForPushData } from "./pushRouting";
import { ROUTES } from "./routeForState";

describe("routeForPushData", () => {
  it("takes a matched user straight to the pitch (#462)", () => {
    expect(routeForPushData({ type: "MATCH_FOUND", matchId: "m-1" }, true)).toBe(ROUTES.pitch);
  });

  // Both concern a date that is already set. DEBRIEF_NUDGE left this group in
  // #468: the debrief screen exists now, so the nudge deep-links there instead.
  it.each(["DATE_ASSIGNED", "PRE_DATE_REMINDER"])(
    "routes %s to the date card for a signed-in user",
    (type) => {
      expect(routeForPushData({ type, matchId: "m-1" }, true)).toBe(ROUTES.blindDate);
    }
  );

  // The nudge is the debrief's front door (#467): the screen's own guard
  // bounces anyone whose date hasn't actually passed, so routing straight
  // there is safe even for a stale tap.
  it("routes a debrief nudge to the debrief chat", () => {
    expect(routeForPushData({ type: "DEBRIEF_NUDGE", matchId: "m-1" }, true)).toBe(ROUTES.debrief);
  });

  // The odd one out since #439: a check-in nudge fits no particular state, and
  // now that the pool has a screen of its own, guessing wrong means a visible
  // bounce. Boot asks the api instead.
  it("sends a check-in nudge to the boot screen to re-derive", () => {
    expect(routeForPushData({ type: "CHECKIN_PROMPT", matchId: "m-1" }, true)).toBe(ROUTES.boot);
  });

  it("sends a signed-out user to login whatever the type", () => {
    // A push that arrives after sign-out must not open someone else's match.
    expect(routeForPushData({ type: "MATCH_FOUND", matchId: "m-1" }, false)).toBe(ROUTES.login);
  });

  it("navigates nowhere for an unknown type", () => {
    // A push can outlive the build that sent it. Leaving the user where they
    // are beats throwing inside a notification listener.
    expect(routeForPushData({ type: "SOMETHING_NEW" }, true)).toBeNull();
  });

  it.each([[null], [undefined], [{}], ["not an object"], [{ type: 123 }]])(
    "navigates nowhere for a malformed payload: %s",
    (data) => {
      expect(routeForPushData(data, true)).toBeNull();
    }
  );

  it("does not require matchId", () => {
    // CHECKIN_PROMPT carries no match.
    expect(routeForPushData({ type: "CHECKIN_PROMPT" }, true)).toBe(ROUTES.boot);
  });
});
