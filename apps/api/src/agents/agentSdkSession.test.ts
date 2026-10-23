import { describe, it, expect, vi, beforeEach } from "vitest";

// Each turn now writes one AgentCall row (#553) — mocked so these tests stay
// database-free.
vi.mock("@wingman/database", () => ({
  prisma: { agentCall: { create: vi.fn() } },
}));

import { prisma } from "@wingman/database";
import { createAgentSession, type QueryFn } from "./agentSdkSession";
import { AgentSdkUnavailableError } from "./agentSdkClient";

beforeEach(() => {
  vi.clearAllMocks();
});

// The audit context every session must now declare (#553).
const AUDIT = { actor: "interview_helper", purpose: "interview_soft_turn", userId: "u-1" } as const;

// A fake `query` that keeps ONE stream alive across turns: it reads user messages
// from the streaming-input prompt and, per message, emits an assistant echo plus
// a result. Records how many times it was invoked so a test can prove the session
// reuses a single underlying stream instead of spawning one per turn.
function fakeQuery(options?: {
  failOnText?: string;
  errorResult?: boolean;
  assistantErrorOnText?: string;
}): {
  fn: QueryFn;
  calls: () => number;
  closed: () => boolean;
} {
  let calls = 0;
  let closed = false;
  const fn: QueryFn = ({ prompt }) => {
    calls += 1;
    const stream = (async function* () {
      for await (const userMessage of prompt) {
        const content = userMessage.message.content as string;
        if (options?.failOnText && content.includes(options.failOnText)) {
          yield { type: "result", subtype: "error_during_execution", is_error: true } as never;
          continue;
        }
        if (options?.assistantErrorOnText && content.includes(options.assistantErrorOnText)) {
          // An assistant-level error mid-turn: classifyAssistantMessage throws
          // on this message, but the stream still owes this turn its terminal
          // `result` message before the next turn's messages can be read.
          yield {
            type: "assistant",
            message: { content: [] },
            error: "boom_error",
          } as never;
          yield { type: "result", subtype: "error_during_execution", is_error: true } as never;
          continue;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: `echo:${content}` }] },
        } as never;
        yield {
          type: "result",
          subtype: "success",
          is_error: options?.errorResult ?? false,
        } as never;
      }
    })();
    return Object.assign(stream, {
      close: () => {
        closed = true;
      },
    });
  };
  return { fn, calls: () => calls, closed: () => closed };
}

describe("createAgentSession", () => {
  it("serves multiple turns from a single underlying stream (spawn paid once)", async () => {
    const fake = fakeQuery();
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });

    const first = await session.run("apple");
    const second = await session.run("banana");
    const third = await session.run("cherry");

    expect(first.text).toBe("echo:apple");
    expect(second.text).toBe("echo:banana");
    expect(third.text).toBe("echo:cherry");
    // One query() call total — the subprocess was reused, not respawned per turn.
    expect(fake.calls()).toBe(1);
  });

  it("does not spawn anything until the first run()", () => {
    const fake = fakeQuery();
    createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });
    expect(fake.calls()).toBe(0);
  });

  it("closes the underlying stream and refuses further turns after close()", async () => {
    const fake = fakeQuery();
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });

    await session.run("apple");
    session.close();

    expect(fake.closed()).toBe(true);
    await expect(session.run("banana")).rejects.toThrow(/closed/);
  });

  it("close() is idempotent", async () => {
    const fake = fakeQuery();
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });
    await session.run("apple");
    session.close();
    expect(() => session.close()).not.toThrow();
  });

  it("throws when a turn ends in an error result", async () => {
    const fake = fakeQuery({ failOnText: "boom" });
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });
    await expect(session.run("boom")).rejects.toThrow(/agent query failed/);
  });

  it("serializes overlapping turns so their messages never interleave", async () => {
    const fake = fakeQuery();
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });

    // Fire two turns without awaiting the first — they must still resolve to
    // their own replies in order.
    const [a, b] = await Promise.all([session.run("apple"), session.run("banana")]);
    expect(a.text).toBe("echo:apple");
    expect(b.text).toBe("echo:banana");
    expect(fake.calls()).toBe(1);
  });

  it("pays the spawn up front via a warm-up turn, and the first real run reuses it", async () => {
    const fake = fakeQuery();
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });

    // The spawn is normally lazy — nothing invoked until a turn runs.
    expect(fake.calls()).toBe(0);
    session.prewarm();
    // The first real run() queues behind prewarm's warm-up turn (both serialized
    // on the same tail). Awaiting it guarantees the warm-up has completed.
    const first = await session.run("apple");

    expect(first.text).toBe("echo:apple");
    // One query() call total: the warm-up spawned the subprocess and the real
    // turn reused it — the spawn was paid exactly once.
    expect(fake.calls()).toBe(1);
  });

  it("prewarm() is idempotent — one warm-up, one spawn", async () => {
    const fake = fakeQuery();
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });

    session.prewarm();
    session.prewarm();
    session.prewarm();
    await session.run("apple");
    expect(fake.calls()).toBe(1);
  });

  it("prewarm() is a no-op after close() — no spawn, no warm-up turn", async () => {
    const fake = fakeQuery();
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });

    session.close();
    session.prewarm();
    // Nothing was spawned and the session still refuses turns.
    await expect(session.run("apple")).rejects.toThrow(/closed/);
    expect(fake.calls()).toBe(0);
  });

  // Issue #410: the warm session's persistent subprocess can die (e.g. the
  // CLI's own root/sudo refusal of --dangerously-skip-permissions), which the
  // SDK surfaces as a rejected `iterator.next()` rather than a stream message —
  // it must not reach the caller as a generic, unclassified Error.
  it("classifies a subprocess crash mid-session as AgentSdkUnavailableError", async () => {
    // Simulates iterator.next() rejecting instead of yielding a message —
    // matching how the SDK's process transport actually fails (a plain Error
    // thrown from the stream, not surfaced as a message).
    const fn: QueryFn = () =>
      Object.assign(
        {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.reject(new Error("Claude Code process exited with code 1")),
            };
          },
        },
        { close: () => {} }
      );

    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fn,
      audit: AUDIT,
    });
    await expect(session.run("hello")).rejects.toThrow(AgentSdkUnavailableError);
  });

  it("stays in sync for later turns after a mid-turn assistant error", async () => {
    const fake = fakeQuery({ assistantErrorOnText: "boom" });
    const session = createAgentSession({
      logLabel: "test",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fake.fn,
      audit: AUDIT,
    });

    await expect(session.run("boom")).rejects.toThrow();
    // Without draining the failed turn's terminal `result` message, this next
    // run() would read that stale message instead of its own reply.
    const next = await session.run("apple");
    expect(next.text).toBe("echo:apple");
  });
});

describe("AgentSession — audit context (#553)", () => {
  it("does not strand the turn queue when the audit context is rejected", async () => {
    const { fn } = fakeQuery();
    const session = createAgentSession({
      logLabel: "softTurn",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fn,
      // The shape the runtime guard exists for. // explanation: deliberately
      // invalid, to prove a rejected context cannot deadlock the session.
      audit: { actor: "not_an_actor" } as never,
    });

    await expect(session.run("first")).rejects.toThrow(/missing valid audit context/);
    // The serialization slot must still be free: a second turn has to fail the
    // same way rather than hang on a promise the first turn never resolved.
    await expect(session.run("second")).rejects.toThrow(/missing valid audit context/);
  });

  it("records one row per turn, and prewarm's throwaway turn under its own purpose", async () => {
    const { fn } = fakeQuery();
    const session = createAgentSession({
      logLabel: "softTurn",
      systemPrompt: "sys",
      model: "m",
      queryImpl: fn,
      audit: AUDIT,
    });

    session.prewarm();
    await session.run("a real soft turn");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const purposes = vi
      .mocked(prisma.agentCall.create)
      .mock.calls.map((call) => (call[0] as { data: { purpose: string } }).data.purpose);
    expect(purposes).toEqual(["session_prewarm", "interview_soft_turn"]);
  });
});
