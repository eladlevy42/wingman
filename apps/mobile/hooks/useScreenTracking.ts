import { useEffect } from "react";
import { usePathname } from "expo-router";
import { trackScreen } from "~/lib/telemetry";

/**
 * Emits one SCREEN_VIEWED per route the user lands on (#554).
 *
 * Mounted once in the root layout rather than per screen, for the same reason
 * useNotificationPoll is: a screen added later would otherwise be silently
 * missing from the funnel, and a hole in telemetry looks exactly like a
 * drop-off. usePathname re-renders on every navigation, including a back
 * gesture, so a screen returned to counts again — which is what a view is.
 */
export function useScreenTracking(): void {
  const pathname = usePathname();

  useEffect(() => {
    trackScreen(pathname);
  }, [pathname]);
}
