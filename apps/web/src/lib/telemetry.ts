import {
  createScreenViewGate,
  createTelemetryQueue,
  screenForPath,
  TelemetryResponseSchema,
  type AuditEventPayload,
  type ClientAuditEventType,
  type TelemetryAction,
  type TelemetryBatch,
  type TelemetryQueue,
} from "@wingman/shared";

// Client telemetry for the web app (docs/adr/0038, #554). The queue — batching,
// capping, dropping — is the shared one, so web and mobile behave identically;
// this file is the browser half.
//
// Web has 37 direct `fetch(` calls and no central API client, so unlike mobile
// there is no chokepoint to hang this on. That asymmetry is in the ADR: web
// emits from a router-level listener plus explicit calls at key actions, and
// this file deliberately does NOT become the api-client wrapper web never had.

/**
 * Generates the per-load anonymous id.
 *
 * `crypto.randomUUID` exists only in a SECURE context, and this app is
 * deliberately served over plain http to phones on the same Wi-Fi (see
 * vite.config.ts `host: true`) — where it is undefined. Calling it unguarded at
 * module scope would throw during import and take the whole app down on exactly
 * that setup, so this steps down: `getRandomValues` is available on insecure
 * origins too, and the last branch covers anything older still.
 *
 * Stepping down costs nothing that matters here. The id has to be unique among
 * concurrent sessions, not unguessable: it is never persisted, never linked to
 * a person, and by itself identifies nobody (docs/adr/0038).
 */
function randomAnonSessionId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * The Anonymous Session Id (docs/adr/0038).
 *
 * Generated once per page load and held in memory only — never written to
 * localStorage or a cookie. A persisted id stitched to a userId at
 * registration is the retroactive-identification pattern the ADR rejects, so
 * the id simply does not outlive the tab.
 */
const ANON_SESSION_ID = randomAnonSessionId();

export const FLUSH_INTERVAL_MS = 30_000;

async function send(batch: TelemetryBatch): Promise<void> {
  const response = await fetch("/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  if (!response.ok) throw new Error(`telemetry: ${response.status}`);
  // Parsed so a contract drift surfaces as a rejected send (and therefore a
  // drop) rather than as silently discarded events.
  TelemetryResponseSchema.parse(await response.json());
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
 * on the route, and one navigation can run it more than once — React
 * StrictMode double-invokes effects in development, which would otherwise
 * double-count every screen in the funnel (see createScreenViewGate).
 */
export function trackScreen(path: string): void {
  const screen = screenForPath(path);
  if (!screenViewGate(screen)) return;
  track("SCREEN_VIEWED", { screen, client: "web" });
}

/** Queues one of the funnel taps the server cannot see when they fail. */
export function trackAction(path: string, action: TelemetryAction): void {
  track("CTA_TAPPED", { screen: screenForPath(path), action, client: "web" });
}

/**
 * Binds subsequent events to a signed-in user. Events already queued keep the
 * anonymous subject they were emitted under — signing in never backfills.
 */
export function setTelemetryUser(userId: string | null): void {
  queue.setUser(userId);
}

/** Sends whatever is queued. Never rejects — a failed flush drops its events. */
export function flushTelemetry(): Promise<void> {
  return queue.flush();
}

/** Queue depth. Exported for tests; no page reads it. */
export function queuedTelemetryCount(): number {
  return queue.size();
}

/**
 * Starts the flush timer and the page-hide hook, returning a teardown.
 *
 * `visibilitychange` rather than `beforeunload`: the latter does not fire
 * reliably on mobile browsers or on a backgrounded tab, and a tab closed on the
 * Register screen is exactly the event this exists to capture.
 */
export function startTelemetry(): () => void {
  const timer = setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS);
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") void flushTelemetry();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
