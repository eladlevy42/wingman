import { describe, expect, it } from "vitest";
import {
  AgentCallRecordSchema,
  AgentAuditContextSchema,
  AgentActorSchema,
  AgentPurposeSchema,
} from "./agentCall";

// The AgentCall row shape is the privacy gate for agent telemetry, exactly as
// the event vocabulary is for AuditEvent (audit.test.ts). These pin it
// structurally, so a future field cannot quietly widen what agent calls record.

function validRecord() {
  return {
    correlationId: "corr-1",
    userId: "u-1",
    actor: "barney" as const,
    purpose: "interview_turn" as const,
    model: "claude-haiku-4-5",
    costUsd: 0.002,
    durationMs: 1200,
    toolNames: ["saveProfile"],
    retryCount: 0,
    outcome: "ok" as const,
    errorMessage: null,
  };
}

describe("AgentCallRecordSchema", () => {
  it("accepts a well-formed row", () => {
    expect(AgentCallRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it("accepts a row with no user in scope", () => {
    expect(
      AgentCallRecordSchema.safeParse({
        ...validRecord(),
        userId: null,
        actor: "evalJudge",
        purpose: "eval_judgement",
      }).success
    ).toBe(true);
  });

  // The structural half of docs/adr/0038's metadata-only rule: content fields
  // are not merely unused, they are unrepresentable.
  it.each([
    "prompt",
    "systemPrompt",
    "response",
    "text",
    "transcript",
    "thinking",
    "toolInputs",
    "email",
    "phone",
    "name",
    "studentId",
    "photoUrl",
  ])("refuses a row carrying %s", (field) => {
    const result = AgentCallRecordSchema.safeParse({
      ...validRecord(),
      [field]: "anything at all",
    });
    expect(result.success).toBe(false);
  });

  it("declares no field that could hold free-form content", () => {
    // Every declared key is an id, an enum, a number, or the bounded error
    // code. Read as a list, this is the whole privacy claim for the table.
    expect(Object.keys(AgentCallRecordSchema.shape).sort()).toEqual([
      "actor",
      "correlationId",
      "costUsd",
      "durationMs",
      "errorMessage",
      "model",
      "outcome",
      "purpose",
      "retryCount",
      "toolNames",
      "userId",
    ]);
  });

  it("caps errorMessage so a stack trace or a long message cannot land in it", () => {
    const result = AgentCallRecordSchema.safeParse({
      ...validRecord(),
      outcome: "failed",
      errorMessage: "x".repeat(1000),
    });
    expect(result.success).toBe(false);
  });

  it("refuses a negative cost or a fractional duration", () => {
    expect(AgentCallRecordSchema.safeParse({ ...validRecord(), costUsd: -1 }).success).toBe(false);
    expect(AgentCallRecordSchema.safeParse({ ...validRecord(), durationMs: 1.5 }).success).toBe(
      false
    );
  });
});

describe("AgentAuditContextSchema", () => {
  it("requires an actor and a purpose", () => {
    expect(AgentAuditContextSchema.safeParse({}).success).toBe(false);
    expect(AgentAuditContextSchema.safeParse({ actor: "barney" }).success).toBe(false);
  });

  it("treats userId as optional so eval graders can attribute to no one", () => {
    expect(
      AgentAuditContextSchema.safeParse({ actor: "evalJudge", purpose: "eval_judgement" }).success
    ).toBe(true);
  });

  it("refuses an actor or purpose outside the closed vocabulary", () => {
    expect(
      AgentAuditContextSchema.safeParse({ actor: "mystery", purpose: "interview_turn" }).success
    ).toBe(false);
    expect(
      AgentAuditContextSchema.safeParse({ actor: "barney", purpose: "doing_something" }).success
    ).toBe(false);
  });
});

describe("the vocabularies stay closed", () => {
  it("names every actor the app can run", () => {
    expect([...AgentActorSchema.options].sort()).toEqual([
      "barney",
      "consistencyJudge",
      "evalJudge",
      "groundednessJudge",
      "interview_helper",
      "negotiation",
    ]);
  });

  it("names every purpose an agent call can have", () => {
    expect([...AgentPurposeSchema.options].sort()).toEqual([
      "dealbreaker_consistency",
      "debrief_turn",
      "eval_judgement",
      "fallback_rationale",
      "groundedness_check",
      "interview_addendum",
      "interview_side_question",
      "interview_soft_turn",
      "interview_turn",
      "negotiation_rationale",
      "negotiation_score",
      "negotiation_turn",
      "pitch_turn",
      "session_prewarm",
    ]);
  });
});
