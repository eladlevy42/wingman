import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuditEventPayloadSchemas,
  AuditEventTypeSchema,
  parseAuditPayload,
  type AuditEventType,
} from "./audit";

// A representative valid payload per type — used to prove strictness (valid +
// one extra key must fail) without repeating shapes in every test.
const VALID_PAYLOADS: Record<AuditEventType, Record<string, unknown>> = {
  USER_REGISTERED: {},
  USER_DELETED: {},
  USER_AUTHENTICATED: { method: "password" },
  MATCHING_STATE_CHANGED: {
    from: "IDLE",
    to: "WAITING",
    trigger: "phase2_completed",
  },
  INTERVIEW_TURN: { mode: "interview_self", latencyMs: 1200, answerLength: 42 },
  INTERVIEW_COMPLETED: { mode: "interview_wants" },
  INTERVIEW_LANGUAGE_CHANGED: { mode: "interview_self", language: "en" },
  PHOTO_UPLOADED: {},
  PITCH_DECIDED: {
    matchId: "5e0e77ae-0000-4000-8000-000000000001",
    decision: "yeah",
  },
  TIMES_PROPOSED: {
    matchId: "5e0e77ae-0000-4000-8000-000000000001",
    slotCount: 3,
  },
  TIMES_CHOSEN: { matchId: "5e0e77ae-0000-4000-8000-000000000001" },
  DEBRIEF_COMPLETED: { matchId: "5e0e77ae-0000-4000-8000-000000000001" },
  SCREEN_VIEWED: { screen: "register", client: "mobile" },
  CTA_TAPPED: { screen: "register", action: "register_submitted", client: "web" },
};

describe("the audit event vocabulary", () => {
  it("has exactly one payload schema per vocabulary member", () => {
    expect(Object.keys(AuditEventPayloadSchemas).sort()).toEqual(
      [...AuditEventTypeSchema.options].sort()
    );
  });

  it.each(AuditEventTypeSchema.options)("accepts a valid %s payload", (type) => {
    expect(parseAuditPayload(type, VALID_PAYLOADS[type]).success).toBe(true);
  });

  // The gate is .strict(): an undeclared field is a parse failure, not a
  // passenger — which is what makes "no PII can reach the table" enforceable
  // rather than promised (docs/adr/0038).
  it.each(AuditEventTypeSchema.options)("rejects a %s payload carrying an extra field", (type) => {
    expect(parseAuditPayload(type, { ...VALID_PAYLOADS[type], email: "a@b.c" }).success).toBe(
      false
    );
  });
});

describe("the privacy gate (docs/adr/0038)", () => {
  const BANNED_KEYS = ["email", "phone", "name", "studentId", "photoUrl"];

  it("declares none of the banned identifying fields on any payload", () => {
    for (const [type, schema] of Object.entries(AuditEventPayloadSchemas)) {
      const keys = Object.keys(schema.shape);
      for (const banned of BANNED_KEYS) {
        expect(keys, `${type} must not declare "${banned}"`).not.toContain(banned);
      }
    }
  });

  // No free-form text either: every field must be a closed enum, a bounded
  // number, or — for matchId only — a UUID-constrained string. A plain
  // z.string() anywhere in the vocabulary is how "metadata only" erodes into a
  // log-message field, so this fails the moment a future event type adds one.
  it("admits no free-form string field on any payload", () => {
    for (const [type, schema] of Object.entries(AuditEventPayloadSchemas)) {
      for (const [key, field] of Object.entries(schema.shape)) {
        const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
        if (inner instanceof z.ZodString) {
          expect(key, `${type}.${key} is a string and must be the UUID match key`).toBe("matchId");
          const hasUuidCheck = inner._def.checks.some((check) => check.kind === "uuid");
          expect(hasUuidCheck, `${type}.${key} must be UUID-constrained`).toBe(true);
        } else {
          expect(
            inner instanceof z.ZodEnum || inner instanceof z.ZodNumber,
            `${type}.${key} must be an enum or a number, got ${inner.constructor.name}`
          ).toBe(true);
        }
      }
    }
  });
});
