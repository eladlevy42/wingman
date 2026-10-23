import { z } from "zod";

// Client telemetry (docs/adr/0038, #554). Server-side events only exist once a
// request is made, so someone who opens Register and leaves produces no data at
// all. These are the events the two clients emit for themselves.
//
// Everything here is UNTRUSTED INPUT: an attacker can POST whatever a client
// can. The closed enums below are what keeps that from turning the audit trail
// into a free-text store — a screen name is one of a known list, not a string.

// Which client emitted the event. Kept as a field rather than two event types
// so a funnel query reads one row shape and can group by client when it wants.
export const TelemetryClientSchema = z.enum(["mobile", "web"]);

export type TelemetryClient = z.infer<typeof TelemetryClientSchema>;

// Every screen either client can show, as one closed vocabulary. Named by what
// the screen IS rather than by its path, so the two clients' differing routes
// ("/barney/phase1" on both, but only web has "/welcome") land on comparable
// names and the mobile/web funnels can be read side by side.
export const TelemetryScreenSchema = z.enum([
  "splash",
  "welcome",
  "register",
  "authenticate",
  "login",
  "verify",
  "verified",
  "interview_self",
  "interview_wants",
  "completion",
  "waiting",
  "pitch",
  "choose_times",
  "blind_date",
  "debrief",
  // Any route not in the map — a dev page, a typo, a route added without
  // being named here. Recorded rather than dropped so a hole in the map is
  // visible in the data instead of silently costing events.
  "unknown",
]);

export type TelemetryScreen = z.infer<typeof TelemetryScreenSchema>;

// The taps worth recording from the client: the pre-auth funnel actions the
// server cannot see when they fail. A tap that never became a request is
// exactly the drop-off ADR-0038 says is invisible today.
export const TelemetryActionSchema = z.enum([
  "register_submitted",
  "login_submitted",
  "verification_submitted",
  "interview_started",
]);

export type TelemetryAction = z.infer<typeof TelemetryActionSchema>;

// Path -> screen, shared because both clients must name the same screen the
// same way for a funnel to mean anything. A second copy would be a correctness
// risk, not a convenience (CLAUDE.md §3).
const SCREEN_BY_PATH: Record<string, TelemetryScreen> = {
  "/": "splash",
  "/welcome": "welcome",
  "/register": "register",
  "/authenticate": "authenticate",
  "/login": "login",
  "/verify": "verify",
  "/verified": "verified",
  "/barney/phase1": "interview_self",
  "/barney/phase2": "interview_wants",
  "/completion": "completion",
  "/waiting": "waiting",
  "/pitch": "pitch",
  "/choose-times": "choose_times",
  "/blind-date": "blind_date",
  "/debrief": "debrief",
};

/**
 * The screen a route path represents, or "unknown" for a path outside the map.
 *
 * Query strings and trailing slashes are stripped first: a path is a screen
 * identity here, and `?matchId=...` would both fragment the funnel and carry an
 * id into a payload that is supposed to hold none.
 */
export function screenForPath(path: string): TelemetryScreen {
  const withoutQuery = path.split(/[?#]/)[0] ?? "";
  // Only a path of "/" keeps its slash; "/waiting/" and "/waiting" are the
  // same screen. An empty path is not the root — it is no path at all, and
  // falls through to "unknown".
  const normalized = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
  return SCREEN_BY_PATH[normalized] ?? "unknown";
}

// A telemetry POST is one round trip for many events, so the batch — not the
// event — is the unit the endpoint rate-limits and caps. 50 is comfortably
// above a normal flush (a client emits a handful of events per interval) and
// far below anything that would stall SQLite's single writer.
export const MAX_TELEMETRY_BATCH = 50;

// `type` is deliberately a loose string rather than the enum: an entry naming
// an unknown type must be DROPPED without failing the batch around it (#554),
// which means it has to parse at this level and be rejected one level down.
// The batch shape itself is strict — that is what a 400 is for.
export const TelemetryEventSchema = z
  .object({
    type: z.string().min(1).max(64),
    payload: z.unknown(),
  })
  .strict();

export const TelemetryBatchSchema = z
  .object({
    // Exactly one of these, never both. Both together is the stitch ADR-0038
    // rejects — it would link an anonymous pre-auth session to a person — so it
    // is refused at the boundary rather than resolved in favour of one.
    userId: z.string().min(1).max(64).optional(),
    anonSessionId: z.string().min(1).max(64).optional(),
    events: z.array(TelemetryEventSchema).min(1).max(MAX_TELEMETRY_BATCH),
  })
  .strict()
  .refine((batch) => (batch.userId == null) !== (batch.anonSessionId == null), {
    message: "exactly one of userId or anonSessionId is required",
  });

export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

// What the endpoint reports back: how much of the batch survived validation.
// Useful in a dev console and in tests; carries no data back to the client.
export const TelemetryResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
  })
  .strict();

export type TelemetryResponse = z.infer<typeof TelemetryResponseSchema>;
