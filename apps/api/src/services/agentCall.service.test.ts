import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    agentCall: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from "@wingman/database";
import type { AgentCallRecord } from "@wingman/shared";
import { recordAgentCall, resolveAuditContext, AgentAuditContextError } from "./agentCall.service";
import { runWithCorrelationId } from "../middleware/correlationId";

// recordAgentCall logs every drop, and the tests assert it does — but the
// messages themselves are noise in the test output.
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

function record(overrides: Partial<AgentCallRecord> = {}): AgentCallRecord {
  return {
    correlationId: "corr-1",
    userId: "u-1",
    actor: "barney",
    purpose: "interview_turn",
    model: "claude-haiku-4-5",
    costUsd: 0.001,
    durationMs: 900,
    toolNames: ["saveProfile"],
    retryCount: 0,
    outcome: "ok",
    errorMessage: null,
    ...overrides,
  };
}

function createdRow(): Record<string, unknown> {
  const call = vi.mocked(prisma.agentCall.create).mock.calls[0]![0] as {
    data: Record<string, unknown>;
  };
  return call.data;
}

describe("recordAgentCall", () => {
  it("writes a row when the record matches the schema", async () => {
    await recordAgentCall(record());

    expect(prisma.agentCall.create).toHaveBeenCalledTimes(1);
    const row = createdRow();
    expect(row.actor).toBe("barney");
    expect(row.outcome).toBe("ok");
    // The array column is a JSON-encoded string on SQLite.
    expect(JSON.parse(row.toolNames as string)).toEqual(["saveProfile"]);
  });

  it("drops a row carrying a field the schema does not declare", async () => {
    await recordAgentCall({
      ...record(),
      // The exact shape the strict schema exists to refuse. // explanation:
      // deliberately invalid, to prove the write path rejects it.
      prompt: "tell me about your last relationship",
    } as unknown as AgentCallRecord);

    expect(prisma.agentCall.create).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("drops a row with an actor outside the closed vocabulary", async () => {
    await recordAgentCall(record({ actor: "some_new_agent" as AgentCallRecord["actor"] }));

    expect(prisma.agentCall.create).not.toHaveBeenCalled();
  });

  it("drops a row whose outcome is not one of the four", async () => {
    await recordAgentCall(record({ outcome: "weird" as AgentCallRecord["outcome"] }));

    expect(prisma.agentCall.create).not.toHaveBeenCalled();
  });

  it("never throws when the database write rejects", async () => {
    vi.mocked(prisma.agentCall.create).mockRejectedValueOnce(new Error("database is locked"));

    await expect(recordAgentCall(record())).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("resolveAuditContext", () => {
  it("takes the correlationId of the request in scope", () => {
    const resolved = runWithCorrelationId(
      () =>
        resolveAuditContext("test", { actor: "barney", purpose: "interview_turn", userId: "u" }),
      "request-corr"
    );

    expect(resolved.correlationId).toBe("request-corr");
    expect(resolved.userId).toBe("u");
  });

  it("falls back to a fresh id outside any request scope", () => {
    const resolved = resolveAuditContext("test", {
      actor: "evalJudge",
      purpose: "eval_judgement",
      userId: null,
    });

    expect(resolved.correlationId).toEqual(expect.any(String));
    expect(resolved.correlationId.length).toBeGreaterThan(0);
    expect(resolved.userId).toBeNull();
  });

  it("prefers an explicitly passed correlationId over the ambient one", () => {
    const resolved = runWithCorrelationId(
      () =>
        resolveAuditContext("test", {
          actor: "negotiation",
          purpose: "negotiation_turn",
          userId: "u",
          correlationId: "explicit",
        }),
      "request-corr"
    );

    expect(resolved.correlationId).toBe("explicit");
  });

  it("throws rather than attributing a call with no context", () => {
    expect(() => resolveAuditContext("test", undefined)).toThrow(AgentAuditContextError);
  });

  it("throws on an actor or purpose outside the vocabulary", () => {
    expect(() =>
      resolveAuditContext("test", {
        actor: "barney",
        purpose: "whatever_it_was_doing",
      } as never)
    ).toThrow(AgentAuditContextError);
  });
});
