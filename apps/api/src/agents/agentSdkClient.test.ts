import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

// runAgentQuery now writes one AgentCall row per call (#553). Mocked at the
// database rather than at the service so these tests exercise the real
// parse-then-write path — including its refusal to write content.
vi.mock("@wingman/database", () => ({
  prisma: { agentCall: { create: vi.fn() }, auditEvent: { create: vi.fn() } },
}));

import { prisma } from "@wingman/database";
import { recordEvent } from "../services/audit.service";
import { runWithCorrelationId } from "../middleware/correlationId";
import {
  runAgentQuery,
  AgentAuthError,
  AgentTruncatedError,
  AgentSdkUnavailableError,
  isProcessLevelFailure,
  extractThinking,
} from "./agentSdkClient";

// Wraps a fixed array of SDKMessage-shaped objects as the async iterable
// `query()` returns, so each test can script a turn's message stream.
function messagesOf(...messages: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const message of messages) yield message;
    },
  };
}

// Simulates the SDK's process transport throwing mid-iteration — the shape
// the real `claude` CLI subprocess crash takes (issue #410), which arrives as
// a rejected `next()` from the async iterator rather than as a stream
// message, so it never reaches classifyAssistantMessage.
function crashingAfter(message: string, ...messages: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const m of messages) yield m;
      throw new Error(message);
    },
  };
}

function assistantText(text: string, error?: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] }, error };
}

function assistantToolUse(name: string, input: unknown, id = "tu_1") {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

function resultOk() {
  return { type: "result", subtype: "success", is_error: false };
}

// The audit context every call must now carry (#553).
const AUDIT = { actor: "barney", purpose: "interview_turn", userId: "u-1" } as const;

// The AgentCall row written by the call under test, or undefined if none was.
function writtenRow(): Record<string, unknown> | undefined {
  const call = vi.mocked(prisma.agentCall.create).mock.calls[0]?.[0] as
    | { data: Record<string, unknown> }
    | undefined;
  return call?.data;
}

// recordAgentCall is fire-and-forget, so the row lands on a microtask after
// runAgentQuery has already returned. One flush is enough — the write itself is
// mocked, so nothing else is pending.
async function flushAuditWrite(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runAgentQuery", () => {
  it("returns the final assistant text", async () => {
    mockQuery.mockReturnValueOnce(messagesOf(assistantText("hello"), resultOk()));

    const result = await runAgentQuery({
      logLabel: "test",
      systemPrompt: "sys",
      prompt: "hi",
      model: "claude-sonnet-4-6",
      audit: AUDIT,
    });

    expect(result.text).toBe("hello");
    expect(result.toolUses).toEqual([]);
  });

  it("collects tool_use blocks across the turn", async () => {
    mockQuery.mockReturnValueOnce(
      messagesOf(assistantToolUse("saveScore", { score: 8 }), assistantText("done"), resultOk())
    );

    const result = await runAgentQuery({
      logLabel: "test",
      systemPrompt: "sys",
      prompt: "hi",
      model: "claude-sonnet-4-6",
      audit: AUDIT,
    });

    expect(result.toolUses).toEqual([
      { type: "tool_use", id: "tu_1", name: "saveScore", input: { score: 8 } },
    ]);
    expect(result.text).toBe("done");
  });

  it("throws AgentAuthError without retrying on an authentication failure", async () => {
    mockQuery.mockReturnValue(messagesOf(assistantText("", "authentication_failed"), resultOk()));

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(AgentAuthError);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("throws AgentTruncatedError on a max_output_tokens error", async () => {
    mockQuery.mockReturnValue(messagesOf(assistantText("", "max_output_tokens"), resultOk()));

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(AgentTruncatedError);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("retries a transient error (rate_limit) and then succeeds", async () => {
    mockQuery
      .mockReturnValueOnce(messagesOf(assistantText("", "rate_limit"), resultOk()))
      .mockReturnValueOnce(messagesOf(assistantText("recovered"), resultOk()));

    const result = await runAgentQuery({
      logLabel: "test",
      systemPrompt: "sys",
      prompt: "hi",
      model: "m",
      audit: AUDIT,
    });

    expect(result.text).toBe("recovered");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient, non-auth error", async () => {
    mockQuery.mockReturnValue(messagesOf(assistantText("", "invalid_request"), resultOk()));

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(/invalid_request/);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("classifies a missing/incompatible executable as AgentSdkUnavailableError too", async () => {
    mockQuery.mockReturnValue(
      crashingAfter("Claude Code executable not found at /usr/bin/claude.")
    );

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(AgentSdkUnavailableError);
  });

  it("throws when the final result reports an error", async () => {
    mockQuery.mockReturnValue(
      messagesOf(assistantText("partial"), {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
      })
    );

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(/error_max_turns/);
  });

  // Issue #410: the Claude Code CLI subprocess can fail to start or die
  // mid-call (e.g. the CLI's own root/sudo refusal of
  // --dangerously-skip-permissions) — the SDK throws a plain Error directly
  // from its process transport rather than surfacing it as a message. This
  // must not propagate as an indistinguishable generic Error, and must not be
  // retried (a dead subprocess environment will not fix itself in 500ms).
  it("classifies a subprocess exit as AgentSdkUnavailableError without retrying", async () => {
    mockQuery.mockReturnValue(crashingAfter("Claude Code process exited with code 1"));

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(AgentSdkUnavailableError);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("classifies a failed spawn as AgentSdkUnavailableError", async () => {
    mockQuery.mockReturnValue(
      crashingAfter("Failed to spawn Claude Code process: spawn claude ENOENT")
    );

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(AgentSdkUnavailableError);
  });

  it("does not misclassify an ordinary error as a subprocess failure", async () => {
    mockQuery.mockReturnValue(crashingAfter("some other unrelated failure"));

    let caught: unknown;
    try {
      await runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(AgentSdkUnavailableError);
    expect((caught as Error).message).toMatch(/some other unrelated failure/);
  });
});

describe("extractThinking", () => {
  it("joins thinking blocks and ignores text/tool_use", () => {
    const blocks = [
      { type: "thinking", thinking: "weighing the kids dealbreaker" },
      { type: "text", text: "So, do you want kids?" },
      { type: "thinking", thinking: "will probe faith next" },
    ];
    expect(extractThinking(blocks)).toBe("weighing the kids dealbreaker\n\nwill probe faith next");
  });
  it("returns empty string when there are no thinking blocks", () => {
    const blocks = [{ type: "text", text: "hi" }];
    expect(extractThinking(blocks)).toBe("");
  });
});

describe("isProcessLevelFailure", () => {
  it("matches process exit / termination / spawn-failure messages", () => {
    expect(isProcessLevelFailure(new Error("Claude Code process exited with code 1"))).toBe(true);
    expect(
      isProcessLevelFailure(new Error("Claude Code process terminated by signal SIGKILL"))
    ).toBe(true);
    expect(
      isProcessLevelFailure(new Error("Failed to spawn Claude Code process: spawn claude ENOENT"))
    ).toBe(true);
  });

  it("matches missing-executable and native-binary launch failures", () => {
    expect(
      isProcessLevelFailure(new Error("Claude Code executable not found at /usr/bin/claude."))
    ).toBe(true);
    expect(isProcessLevelFailure(new Error("Claude Code native binary is incompatible"))).toBe(
      true
    );
  });

  it("does not match an unrelated error or a deliberate abort", () => {
    expect(isProcessLevelFailure(new Error("Claude Code process aborted by user"))).toBe(false);
    expect(isProcessLevelFailure(new Error("network error"))).toBe(false);
    expect(isProcessLevelFailure("not an Error instance")).toBe(false);
  });
});

// #553 — every call through this chokepoint writes exactly one AgentCall row
// (docs/adr/0038). These assert the row itself, not just that a write happened.
describe("runAgentQuery — AgentCall instrumentation", () => {
  it("writes one row per completed call, carrying model, cost, duration, tools and outcome", async () => {
    mockQuery.mockReturnValueOnce(
      messagesOf(assistantText("hello"), assistantToolUse("saveScore", { score: 8 }), {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.0042,
        duration_ms: 1234,
      })
    );

    await runAgentQuery({
      logLabel: "test",
      systemPrompt: "sys",
      prompt: "hi",
      model: "claude-haiku-4-5",
      audit: AUDIT,
    });
    await flushAuditWrite();

    expect(prisma.agentCall.create).toHaveBeenCalledTimes(1);
    const row = writtenRow()!;
    expect(row.actor).toBe("barney");
    expect(row.purpose).toBe("interview_turn");
    expect(row.userId).toBe("u-1");
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.costUsd).toBe(0.0042);
    expect(row.durationMs).toBe(1234);
    // Tool NAMES only — the { score: 8 } argument is never written.
    expect(JSON.parse(row.toolNames as string)).toEqual(["saveScore"]);
    expect(row.retryCount).toBe(0);
    expect(row.outcome).toBe("ok");
    expect(row.errorMessage).toBeNull();
    expect(row.correlationId).toEqual(expect.any(String));
  });

  it("writes a failed row with the retries paid when a transient error exhausts them", async () => {
    vi.useFakeTimers();
    try {
      mockQuery.mockReturnValue(messagesOf(assistantText("", "rate_limit"), resultOk()));

      const pending = runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      });
      const caught = pending.catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      await caught;
      await flushAuditWrite();

      const row = writtenRow()!;
      expect(row.outcome).toBe("failed");
      // Six attempts made, so five retries were paid for before giving up.
      expect(row.retryCount).toBe(5);
      // The SDK's own code for the failure — never the error's free text.
      expect(row.errorMessage).toBe("Error: rate_limit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes an auth failure from a transient exhaustion", async () => {
    mockQuery.mockReturnValue(messagesOf(assistantText("", "authentication_failed"), resultOk()));

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(AgentAuthError);
    await flushAuditWrite();

    const row = writtenRow()!;
    expect(row.outcome).toBe("auth_error");
    expect(row.retryCount).toBe(0);
  });

  it("records a dead subprocess under its own outcome", async () => {
    mockQuery.mockReturnValue(crashingAfter("Claude Code process exited with code 1"));

    await expect(
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      })
    ).rejects.toThrow(AgentSdkUnavailableError);
    await flushAuditWrite();

    expect(writtenRow()!.outcome).toBe("sdk_unavailable");
  });

  it("never writes the prompt or the model's reply, on the success or the failure path", async () => {
    const SECRET_PROMPT = "SECRET-PROMPT-my flat in Haifa with my ex";
    const SECRET_REPLY = "SECRET-REPLY-that sounds like a hard year";

    mockQuery.mockReturnValueOnce(messagesOf(assistantText(SECRET_REPLY), resultOk()));
    await runAgentQuery({
      logLabel: "test",
      systemPrompt: SECRET_PROMPT,
      prompt: SECRET_PROMPT,
      model: "m",
      audit: AUDIT,
    });
    await flushAuditWrite();

    // A transport error whose message quotes something it should not: the row
    // records the class and the code, so there is nowhere for it to land.
    mockQuery.mockReturnValueOnce(
      crashingAfter(`Claude Code process exited with code 1: ${SECRET_REPLY}`)
    );
    await runAgentQuery({
      logLabel: "test",
      systemPrompt: SECRET_PROMPT,
      prompt: SECRET_PROMPT,
      model: "m",
      audit: AUDIT,
    }).catch(() => undefined);
    await flushAuditWrite();

    // Every row written by either path, serialized whole — nothing to hide in.
    const written = JSON.stringify(vi.mocked(prisma.agentCall.create).mock.calls);
    expect(written).not.toContain("SECRET-PROMPT");
    expect(written).not.toContain("SECRET-REPLY");
  });

  it("refuses a call with no audit context instead of writing an unattributed row", async () => {
    await expect(
      // A caller that got past the compile-time requirement — a JS caller, or a
      // cast. // explanation: deliberately constructing the invalid shape the
      // runtime guard exists for.
      runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
      } as unknown as Parameters<typeof runAgentQuery>[0])
    ).rejects.toThrow(/missing valid audit context/);

    // It failed before spending anything, and wrote nothing.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(prisma.agentCall.create).not.toHaveBeenCalled();
  });

  it("returns the agent's result normally when the AgentCall write fails", async () => {
    vi.mocked(prisma.agentCall.create).mockRejectedValueOnce(new Error("database is locked"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQuery.mockReturnValueOnce(messagesOf(assistantText("hello"), resultOk()));

    const result = await runAgentQuery({
      logLabel: "test",
      systemPrompt: "sys",
      prompt: "hi",
      model: "m",
      audit: AUDIT,
    });
    await flushAuditWrite();

    expect(result.text).toBe("hello");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("shares the request's correlationId with the AuditEvent for the same turn", async () => {
    mockQuery.mockReturnValueOnce(messagesOf(assistantText("hello"), resultOk()));

    await runWithCorrelationId(async () => {
      await recordEvent("INTERVIEW_TURN", { mode: "interview_self" }, { userId: "u-1" });
      await runAgentQuery({
        logLabel: "test",
        systemPrompt: "sys",
        prompt: "hi",
        model: "m",
        audit: AUDIT,
      });
    });
    await flushAuditWrite();

    const eventRow = (
      vi.mocked(prisma.auditEvent.create).mock.calls[0]![0] as {
        data: { correlationId: string };
      }
    ).data;
    // The join slice 4's audit page relies on: one user action, its agent calls.
    expect(writtenRow()!.correlationId).toBe(eventRow.correlationId);
  });
});
