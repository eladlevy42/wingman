import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { startTelemetry, trackScreen } from "@/lib/telemetry";

/**
 * Emits one SCREEN_VIEWED per route, and runs the flush timer (#554).
 *
 * Rendered once inside the router rather than added to each page: a page
 * added later is covered without anyone remembering to, and a hole in
 * telemetry is indistinguishable from a drop-off. Renders nothing.
 */
export default function TelemetryTracker() {
  const location = useLocation();

  useEffect(() => startTelemetry(), []);

  useEffect(() => {
    // Path only — the search string can carry a matchId, and a screen-view
    // payload holds no identifiers (docs/adr/0038).
    trackScreen(location.pathname);
  }, [location.pathname]);

  return null;
}
