import type { NotificationType } from "@wingman/shared";
import { PushDataSchema } from "@wingman/shared";
import { ROUTES, type Route } from "./routeForState";

/**
 * Where tapping a push notification should land (#479).
 *
 * Every type now names a real screen (#462, #465, #468). PRE_DATE_REMINDER
 * shares the date card with DATE_ASSIGNED, and DEBRIEF_NUDGE deep-links to the
 * debrief chat: it fires once the date has passed, and the debrief screen's own
 * guard bounces anyone whose state disagrees. Keeping the table explicit rather
 * than collapsing it to a single return means each slice changes one line here
 * and the seam is already covered by tests.
 *
 * CHECKIN_PROMPT has no screen of its own by design — it is a nudge back into
 * the app, not a deep link — so it goes to the boot screen, which re-derives
 * the right destination from the api. It could arrive for a user in any state,
 * and every state now has a different screen, so guessing wrong means a visible
 * bounce off some other screen's guard.
 */
const PUSH_DESTINATION: Record<NotificationType, Route> = {
  MATCH_FOUND: ROUTES.pitch,
  DATE_ASSIGNED: ROUTES.blindDate,
  PRE_DATE_REMINDER: ROUTES.blindDate,
  DEBRIEF_NUDGE: ROUTES.debrief,
  CHECKIN_PROMPT: ROUTES.boot, // re-derives: this one fits no single state
};

/**
 * Resolves the tapped notification's `data` blob to a route.
 *
 * Returns null — meaning "navigate nowhere" — for anything unrecognised. A
 * push can outlive the build that sent it: an older app tapping a type added
 * later, or a malformed payload, must leave the user where they are rather
 * than throwing inside a notification listener or bouncing them somewhere
 * arbitrary.
 *
 * Signed-out users go to login regardless of type. A push that arrives after
 * sign-out is not a reason to show someone else's match.
 *
 * Pure, so the policy is testable without a renderer or a device — same
 * split as guardOutcome/useGuardedRoute.
 */
export function routeForPushData(data: unknown, isSignedIn: boolean): Route | null {
  const parsed = PushDataSchema.safeParse(data);
  if (!parsed.success) return null;
  if (!isSignedIn) return ROUTES.login;
  return PUSH_DESTINATION[parsed.data.type];
}
