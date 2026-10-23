import { randomUUID } from "expo-crypto";
import { AppState, type AppStateStatus } from "react-native";
import {
  createScreenViewGate,
  createTelemetryQueue,
  screenForPath,
  type AuditEventPayload,
  type ClientAuditEventType,
  type TelemetryAction,
  type TelemetryBatch,
  type TelemetryQueue,
} from "@wingman/shared";
import { apiRequest } from "./api";
import { TelemetryResponseSchema } from "@wingman/shared";

// Client telemetry for the mobile app (docs/adr/0038, #554). The queue itself —
// batching, capping, dropping — lives in @wingman/shared so both clients behave
// identically; this file is the platform half: fetch, AppState, and the timer.

/**
 * The Anonymous Session Id (docs/adr/0038).
 *
 * Generated once per app launch at module scope and held in memory only. It is
 * deliberately NOT written to AsyncStorage: a persisted device id stitched to a
 * userId at registration is precisely the retroactive-identification pattern
 * the ADR rejects. Reinstalling is not required to break the link, because
 * there is no link — the id dies with the process.
 */
const ANON_SESSION_ID = randomUUID();

// How often a non-empty queue is drained while the app is in the foreground.
export const FLUSH_INTERVAL_MS = 30_000;

async function send(batch: TelemetryBatch): Promise<void> {
  await apiRequest("/api/telemetry", {
    method: "POST",
    body: batch,
    schema: TelemetryResponseSchema,
  });
}

const queue: TelemetryQueue = createTelemetryQueue({ anonSessionId: ANON_SESSION_ID, send });

/** Queues one client event. Never throws and never blocks the caller. */
export function track<T extends ClientAuditEventType>(
  type: T,
  payload: AuditEventPayload<T>
): void {
  queue.track(type, payload);
}

const screenViewGate = createScreenViewGate();

/**
 * Queues a screen view for a router path, mapped to the shared vocabulary.
 *
 * Ignores a repeat of the screen already showing: the caller is an effect keyed
 * on the route, and one navigation can run it more than once (see
 * createScreenViewGate).
 */
export function trackScreen(path: string): void {
  const screen = screenForPath(path);
  if (!screenViewGate(screen)) return;
  track("SCREEN_VIEWED", { screen, client: "mobile" });
}

/** Queues one of the funnel taps the server cannot see when they fail. */
export function trackAction(path: string, action: TelemetryAction): void {
  track("CTA_TAPPED", { screen: screenForPath(path), action, client: "mobile" });
}

/**
 * Binds subsequent events to a signed-in user. Events already queued keep the
 * anonymous subject they were emitted under, so signing in never backfills a
 * userId onto the pre-auth events that led to it.
 */
export function setTelemetryUser(userId: string | null): void {
  queue.setUser(userId);
}

/** Sends whatever is queued. Never rejects — a failed flush drops its events. */
export function flushTelemetry(): Promise<void> {
  return queue.flush();
}

/** Queue depth. Exported for tests and a dev console; not used by any screen. */
export function queuedTelemetryCount(): number {
  return queue.size();
}

/**
 * Starts the flush timer and the background hook, returning a teardown.
 *
 * Called once from the root layout. Backgrounding matters more than the
 * interval here: an app that is swiped away mid-interval would otherwise lose
 * everything it had queued, and "closed the app on the Register screen" is the
 * exact event the funnel is being built to see.
 */
export function startTelemetry(): () => void {
  const timer = setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS);
  const onAppStateChange = (state: AppStateStatus): void => {
    if (state === "background" || state === "inactive") void flushTelemetry();
  };
  const subscription = AppState.addEventListener("change", onAppStateChange);
  return () => {
    clearInterval(timer);
    subscription.remove();
  };
}
