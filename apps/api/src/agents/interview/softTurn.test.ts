import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunAgentQuery } = vi.hoisted(() => ({ mockRunAgentQuery: vi.fn() }));

vi.mock("../agentSdkClient", () => ({
  runAgentQuery: mockRunAgentQuery,
  // createWarmSoftTurn imports AgentAuthError to distinguish a fatal auth
  // failure from a transient warm-session death (which falls back).
  AgentAuthError: class AgentAuthError extends Error {},
  // agentSdkSession (the warm session backing createWarmSoftTurn) calls this per
  // assistant message; the fake warm query emits no error field, so the real
  // behavior is a no-op — stub it as one so the mock doesn't shadow the export.
  classifyAssistantMessage: vi.fn(),
}));

import { INTERVIEW_HELPER_MODEL } from "../models";
import { parseResult, runSoftTurn, createWarmSoftTurn } from "./softTurn";
import type { QueryFn } from "../agentSdkSession";
import type { SoftTurnFn } from "./softTurn";
import type { SoftNode } from "./questionTree";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseResult", () => {
  it("parses a clean JSON object", () => {
    const result = parseResult(
      '{"sufficient": true, "extracted_value": "engineer", "message": "Nice."}'
    );
    expect(result).toEqual({ sufficient: true, extracted_value: "engineer", message: "Nice." });
  });

  it("tolerates JSON wrapped in stray prose", () => {
    const result = parseResult(
      'Here you go: {"sufficient": false, "extracted_value": null, "message": "Tell me more."} hope that helps'
    );
    expect(result.sufficient).toBe(false);
    expect(result.message).toBe("Tell me more.");
  });

  it("defaults a missing extracted_value to null", () => {
    const result = parseResult('{"sufficient": true, "message": "Got it."}');
    expect(result.extracted_value).toBeNull();
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseResult("totally not json")).toThrow(/no JSON object/);
  });

  it("throws when required fields are missing or mistyped", () => {
    expect(() => parseResult('{"extracted_value": "x", "message": "hi"}')).toThrow(/malformed/);
    expect(() => parseResult('{"sufficient": "yes", "message": "hi"}')).toThrow(/malformed/);
    expect(() => parseResult('{"sufficient": true, "message": 5}')).toThrow(/malformed/);
  });
});

describe("runSoftTurn", () => {
  const node: SoftNode = {
    field: "job",
    bucket: 1,
    text: "What do you do?",
    kind: "soft",
  };

  it("parses the agent query's text into a SoftTurnResult", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({
      text: '{"sufficient": true, "extracted_value": "engineer", "message": "Nice."}',
      toolUses: [],
    });

    const result = await runSoftTurn({
      node,
      answer: "I work in tech",
      mustAdvance: false,
      language: "en",
      questionText: "What do you do?",
      userId: "u-1",
    });

    expect(result).toEqual({ sufficient: true, extracted_value: "engineer", message: "Nice." });
    expect(mockRunAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ logLabel: "softTurn", model: INTERVIEW_HELPER_MODEL })
    );
  });

  it("propagates errors from the agent query (retry/auth/truncation live in agentSdkClient)", async () => {
    mockRunAgentQuery.mockRejectedValueOnce(new Error("network timeout"));

    await expect(
      runSoftTurn({
        node,
        answer: "I work in tech",
        mustAdvance: false,
        language: "en",
        questionText: "What do you do?",
        userId: "u-1",
      })
    ).rejects.toThrow("network timeout");
  });
});

// A fake streaming-input `query` that keeps ONE stream alive across turns,
// emitting a JSON soft-turn payload per user message. Records invocation count so
// a test can prove the warm session spawns once (see agentSdkSession.test.ts for
// the primitive's own coverage). failOnText makes a turn end in an error result.
function fakeWarmQuery(opts: { reply?: string; failOnText?: string } = {}): {
  fn: QueryFn;
  calls: () => number;
} {
  let calls = 0;
  const reply =
    opts.reply ?? '{"sufficient": true, "extracted_value": "engineer", "message": "Nice."}';
  const fn: QueryFn = ({ prompt }) => {
    calls += 1;
    const stream = (async function* () {
      for await (const userMessage of prompt) {
        const content = userMessage.message.content as string;
        if (opts.failOnText && content.includes(opts.failOnText)) {
          yield { type: "result", subtype: "error_during_execution", is_error: true } as never;
          continue;
        }
        yield { type: "assistant", message: { content: [{ type: "text", text: reply }] } } as never;
        yield { type: "result", subtype: "success", is_error: false } as never;
      }
    })();
    return Object.assign(stream, { close: () => {} });
  };
  return { fn, calls: () => calls };
}

describe("createWarmSoftTurn", () => {
  const node: SoftNode = {
    field: "job",
    bucket: 1,
    text: "What do you do?",
    kind: "soft",
  };

  it("serves multiple soft turns from a single warm session (spawn paid once)", async () => {
    const fake = fakeWarmQuery();
    const { softTurn } = createWarmSoftTurn({ userId: "u-1", queryImpl: fake.fn });

    const first = await softTurn({
      node,
      answer: "I build things",
      mustAdvance: false,
      language: "en",
      questionText: "What do you do?",
      userId: "u-1",
    });
    const second = await softTurn({
      node,
      answer: "software",
      mustAdvance: false,
      language: "en",
      questionText: "What do you do?",
      userId: "u-1",
    });

    expect(first).toEqual({ sufficient: true, extracted_value: "engineer", message: "Nice." });
    expect(second.sufficient).toBe(true);
    // One query() call total — the subprocess was reused across both turns.
    expect(fake.calls()).toBe(1);
    // The warm path does not touch the stateless runAgentQuery.
    expect(mockRunAgentQuery).not.toHaveBeenCalled();
  });

  it("prewarm() pays the spawn via a warm-up turn that the first soft turn reuses", async () => {
    const fake = fakeWarmQuery();
    const { softTurn, prewarm } = createWarmSoftTurn({ userId: "u-1", queryImpl: fake.fn });

    prewarm();
    // The first soft turn queues behind prewarm's warm-up turn on the shared
    // session, so awaiting it guarantees the warm-up (and its spawn) completed.
    const result = await softTurn({
      node,
      answer: "software",
      mustAdvance: false,
      language: "en",
      questionText: "What do you do?",
      userId: "u-1",
    });

    expect(result.sufficient).toBe(true);
    // One query() call total: the warm-up spawned the subprocess and the soft
    // turn reused it — no second spawn.
    expect(fake.calls()).toBe(1);
  });

  it("falls back to a fresh stateless call when the warm session fails", async () => {
    const fake = fakeWarmQuery({ failOnText: "software" });
    const fallback = vi.fn<SoftTurnFn>().mockResolvedValue({
      sufficient: true,
      extracted_value: "engineer",
      message: "Fallback reply.",
    });
    const { softTurn } = createWarmSoftTurn({ userId: "u-1", queryImpl: fake.fn, fallback });

    const result = await softTurn({
      node,
      answer: "software",
      mustAdvance: false,
      language: "en",
      questionText: "What do you do?",
      userId: "u-1",
    });

    expect(result.message).toBe("Fallback reply.");
    expect(fallback).toHaveBeenCalledOnce();
  });
});

// ADR-0037 — the language instruction has to reach the model on the *user*
// prompt, not the system prompt: the warm session fixes its system prompt for
// the session's whole life, so a mid-interview toggle would never be seen.
describe("runSoftTurn — language (ADR-0037)", () => {
  const node: SoftNode = { field: "job", bucket: 1, text: "What do you do?", kind: "soft" };

  it("names the reply language and pins extraction to English on the per-turn prompt", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({
      text: '{"sufficient": true, "extracted_value": "engineer", "message": "מעולה."}',
      toolUses: [],
    });

    await runSoftTurn({
      node,
      answer: "אני מהנדס תוכנה",
      mustAdvance: false,
      language: "he",
      questionText: "במה אתם עוסקים?",
      userId: "u-1",
    });

    const call = mockRunAgentQuery.mock.calls[0][0];
    expect(call.prompt).toContain("Reply language: Hebrew");
    expect(call.prompt).toContain("Prompt redacted in the public showcase version.");
    // The model is shown the wording the user actually saw, not the English one.
    expect(call.prompt).toContain("במה אתם עוסקים?");
    // And the standing contract lives in the system prompt.
    expect(call.systemPrompt).toContain("Prompt redacted in the public showcase version.");
  });

  it("names English when the interview is in English", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({
      text: '{"sufficient": true, "extracted_value": "engineer", "message": "Nice."}',
      toolUses: [],
    });

    await runSoftTurn({
      node,
      answer: "I build web apps",
      mustAdvance: false,
      language: "en",
      questionText: "What do you do?",
      userId: "u-1",
    });

    expect(mockRunAgentQuery.mock.calls[0][0].prompt).toContain("Reply language: English");
  });
});
