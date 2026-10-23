import { describe, expect, it } from "vitest";
import {
  MAX_TELEMETRY_BATCH,
  TelemetryBatchSchema,
  TelemetryScreenSchema,
  screenForPath,
} from "./telemetry";
import {
  AuditEventPayloadSchemas,
  CLIENT_AUDIT_EVENT_TYPES,
  isClientAuditEventType,
} from "./audit";

describe("screenForPath", () => {
  it.each([
    ["/", "splash"],
    ["/register", "register"],
    ["/barney/phase1", "interview_self"],
    ["/barney/phase2", "interview_wants"],
    ["/choose-times", "choose_times"],
    ["/blind-date", "blind_date"],
  ])("maps %s to %s", (path, screen) => {
    expect(screenForPath(path)).toBe(screen);
  });

  it("strips a query string, so a matchId can never reach a payload", () => {
    expect(screenForPath("/pitch?matchId=5e0e77ae-0000-4000-8000-000000000001")).toBe("pitch");
  });

  it("ignores a trailing slash", () => {
    expect(screenForPath("/waiting/")).toBe("waiting");
  });

  it("records an unmapped route as unknown rather than dropping it", () => {
    expect(screenForPath("/dev/match-pipeline")).toBe("unknown");
    expect(screenForPath("")).toBe("unknown");
  });

  it("only ever returns a member of the closed vocabulary", () => {
    for (const path of ["/", "/nope", "/register", "/dev/x?y=1"]) {
      expect(TelemetryScreenSchema.safeParse(screenForPath(path)).success).toBe(true);
    }
  });
});

describe("the client-postable subset", () => {
  it("is exactly the two client-emitted event types", () => {
    expect([...CLIENT_AUDIT_EVENT_TYPES]).toEqual(["SCREEN_VIEWED", "CTA_TAPPED"]);
  });

  // The gate that stops a client forging a state transition the server never
  // made. Every server-owned type must be refused.
  it.each([
    "USER_REGISTERED",
    "USER_AUTHENTICATED",
    "USER_DELETED",
    "MATCHING_STATE_CHANGED",
    "INTERVIEW_TURN",
    "INTERVIEW_COMPLETED",
    "INTERVIEW_LANGUAGE_CHANGED",
    "PHOTO_UPLOADED",
    "PITCH_DECIDED",
    "TIMES_PROPOSED",
    "TIMES_CHOSEN",
    "DEBRIEF_COMPLETED",
  ])("refuses %s from a client", (type) => {
    expect(isClientAuditEventType(type)).toBe(false);
  });

  it("refuses a type that is not in the vocabulary at all", () => {
    expect(isClientAuditEventType("ANYTHING_ELSE")).toBe(false);
  });
});

describe("the client event payloads carry no content", () => {
  it.each(["SCREEN_VIEWED", "CTA_TAPPED"] as const)("%s refuses an extra field", (type) => {
    const base =
      type === "SCREEN_VIEWED"
        ? { screen: "register", client: "web" }
        : { screen: "register", action: "register_submitted", client: "web" };
    expect(AuditEventPayloadSchemas[type].safeParse({ ...base, userId: "u-1" }).success).toBe(
      false
    );
    expect(AuditEventPayloadSchemas[type].safeParse({ ...base, email: "a@b.c" }).success).toBe(
      false
    );
    expect(AuditEventPayloadSchemas[type].safeParse({ ...base, text: "hello" }).success).toBe(
      false
    );
  });

  it("refuses a screen or action outside its enum, so neither can hold free text", () => {
    expect(
      AuditEventPayloadSchemas.SCREEN_VIEWED.safeParse({
        screen: "some page the user typed",
        client: "web",
      }).success
    ).toBe(false);
    expect(
      AuditEventPayloadSchemas.CTA_TAPPED.safeParse({
        screen: "register",
        action: "clicked the thing",
        client: "web",
      }).success
    ).toBe(false);
  });
});

describe("TelemetryBatchSchema", () => {
  const event = { type: "SCREEN_VIEWED", payload: { screen: "register", client: "web" } };

  it("accepts an anonymous batch and a user batch", () => {
    expect(TelemetryBatchSchema.safeParse({ anonSessionId: "a", events: [event] }).success).toBe(
      true
    );
    expect(TelemetryBatchSchema.safeParse({ userId: "u-1", events: [event] }).success).toBe(true);
  });

  // Both together is the anon-to-user stitch docs/adr/0038 rejects.
  it("refuses a batch carrying both a userId and an anonSessionId", () => {
    expect(
      TelemetryBatchSchema.safeParse({ userId: "u-1", anonSessionId: "a", events: [event] }).success
    ).toBe(false);
  });

  it("refuses a batch carrying neither", () => {
    expect(TelemetryBatchSchema.safeParse({ events: [event] }).success).toBe(false);
  });

  it("refuses a batch over the cap rather than allowing a truncation", () => {
    const events = Array.from({ length: MAX_TELEMETRY_BATCH + 1 }, () => event);
    expect(TelemetryBatchSchema.safeParse({ anonSessionId: "a", events }).success).toBe(false);
  });

  it("accepts a batch exactly at the cap", () => {
    const events = Array.from({ length: MAX_TELEMETRY_BATCH }, () => event);
    expect(TelemetryBatchSchema.safeParse({ anonSessionId: "a", events }).success).toBe(true);
  });

  it("refuses an empty batch and an unknown top-level field", () => {
    expect(TelemetryBatchSchema.safeParse({ anonSessionId: "a", events: [] }).success).toBe(false);
    expect(
      TelemetryBatchSchema.safeParse({ anonSessionId: "a", events: [event], extra: 1 }).success
    ).toBe(false);
  });

  // An unknown TYPE must survive batch parsing so the service can drop that one
  // entry without failing the batch around it.
  it("lets an unknown event type through the batch shape, for per-entry handling", () => {
    expect(
      TelemetryBatchSchema.safeParse({
        anonSessionId: "a",
        events: [{ type: "MADE_UP", payload: {} }],
      }).success
    ).toBe(true);
  });
});
