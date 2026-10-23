import { describe, expect, it } from "vitest";
import { routeForBannerTap } from "./bannerRouting";
import { routeForPushData } from "./pushRouting";
import { ROUTES } from "./routeForState";

describe("routeForBannerTap", () => {
  it("sends a match to the pitch", () => {
    expect(routeForBannerTap("MATCH_FOUND")).toBe(ROUTES.pitch);
  });

  it("sends an assigned date to the date card", () => {
    expect(routeForBannerTap("DATE_ASSIGNED")).toBe(ROUTES.blindDate);
  });

  // Both destinations are real screens as of #440, so neither is a placeholder
  // standing in for something unbuilt.
  it("names two distinct screens rather than one shared fallback", () => {
    expect(routeForBannerTap("MATCH_FOUND")).not.toBe(routeForBannerTap("DATE_ASSIGNED"));
  });

  // The half that distinguishes a banner from a push. These three are nudges,
  // and the user is already inside the app looking at something — closing the
  // banner is the whole interaction.
  it.each(["PRE_DATE_REMINDER", "DEBRIEF_NUDGE", "CHECKIN_PROMPT"] as const)(
    "navigates nowhere for %s",
    (type) => {
      expect(routeForBannerTap(type)).toBeNull();
    }
  );

  // Pinning the divergence so it stays deliberate. A push tap comes from
  // outside the app — the user chose to come back, so every type lands
  // somewhere. A banner tap happens on a screen they were already using.
  // DEBRIEF_NUDGE joined the divergent set in #467: the push tap deep-links to
  // the debrief chat, the in-app banner still just closes (CONTEXT.md).
  it("differs from a push tap for the nudge types, and deliberately", () => {
    expect(routeForBannerTap("CHECKIN_PROMPT")).toBeNull();
    expect(routeForPushData({ type: "CHECKIN_PROMPT" }, true)).not.toBeNull();
    expect(routeForBannerTap("DEBRIEF_NUDGE")).toBeNull();
    expect(routeForPushData({ type: "DEBRIEF_NUDGE" }, true)).toBe(ROUTES.debrief);
  });

  it("agrees with a push tap for the types that do have a destination", () => {
    for (const type of ["MATCH_FOUND", "DATE_ASSIGNED"] as const) {
      expect(routeForBannerTap(type)).toBe(routeForPushData({ type }, true));
    }
  });
});
