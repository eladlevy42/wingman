import type { NotificationType } from "@wingman/shared";
import { ROUTES, type Route } from "./routeForState";

/**
 * Where tapping an *in-app* notification banner should land (#439).
 *
 * Deliberately not the same table as pushRouting's PUSH_DESTINATION, and the
 * difference is the point. A push tap comes from outside the app: the user
 * chose to come back, so every type navigates somewhere. A banner tap happens
 * while they are already on a screen, possibly mid-interview — so only the
 * types with a destination worth interrupting for navigate at all, and the
 * rest just close the banner. That is what CONTEXT.md specifies, and what web's
 * NotificationBanner does.
 *
 * Both destinations are real screens as of #465 — the pitch (#462) and the date
 * card. Each is guarded, so a tap that arrives after the state has moved on is
 * re-routed by routeForState rather than dead-ending.
 */
const BANNER_DESTINATION: Partial<Record<NotificationType, Route>> = {
  MATCH_FOUND: ROUTES.pitch,
  DATE_ASSIGNED: ROUTES.blindDate,
};

/**
 * Returns the route a banner tap should navigate to, or null for "just close
 * it". PRE_DATE_REMINDER, DEBRIEF_NUDGE and CHECKIN_PROMPT are all nudges
 * rather than deep links — pulling someone off the screen they are on for one
 * would be worse than showing them nothing.
 */
export function routeForBannerTap(type: NotificationType): Route | null {
  return BANNER_DESTINATION[type] ?? null;
}
