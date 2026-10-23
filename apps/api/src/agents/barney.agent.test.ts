import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunAgentQuery } = vi.hoisted(() => ({ mockRunAgentQuery: vi.fn() }));

vi.mock("./agentSdkClient", () => ({ runAgentQuery: mockRunAgentQuery }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((options) => options),
  tool: vi.fn((name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));

// Real prompts are used as-is (deterministic placeholder strings); only the
// tool registry is faked so a tool-use turn has something to call. A fake
// "echo" tool stands in for interview_self; saveWantedProfile (#27) is not yet
// built, so interview_wants stays empty. debrief's fake tool captures the
// context (matchId/transcript) it was called with, so tests can assert
// BarneyAgent threads them through correctly (#75).
const mockEchoHandler = vi.fn();
const mockDebriefFactory = vi.fn(
  (_userId: string, onToolCall: (event: unknown) => void, context: unknown) => ({
    name: "saveFeedback",
    description: "saves debrief feedback",
    inputSchema: {},
    handler: async (input: unknown) => {
      const result = { context };
      onToolCall({ name: "saveFeedback", input, result });
      return result;
    },
  })
);
vi.mock("./tools", () => ({
  TOOL_FACTORIES_BY_MODE: {
    interview_self: [
      (_userId: string, onToolCall: (event: unknown) => void) => ({
        name: "echo",
        description: "echoes the input back",
        inputSchema: {},
        handler: async (input: unknown) => {
          const result = await mockEchoHandler(input);
          onToolCall({ name: "echo", input, result });
          return result;
        },
      }),
    ],
    interview_wants: [],
    pitch: [],
    get debrief() {
      return [mockDebriefFactory];
    },
  },
}));

import { BarneyAgent } from "./barney.agent";
import { PROMPTS_BY_MODE } from "./prompts";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BarneyAgent construction", () => {
  it("instantiates with a mode and userId", () => {
    expect(() => new BarneyAgent("interview_self", "user-1")).not.toThrow();
  });

  it("rejects a mode that is not one of the four valid values", () => {
    // @ts-expect-error -- deliberately passing an invalid mode to test runtime validation
    expect(() => new BarneyAgent("not_a_real_mode", "user-1")).toThrow();
  });
});

describe("context injection", () => {
  it("substitutes a placeholder in the system prompt with the given value", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({ text: "ok", toolUses: [] });

    const agent = new BarneyAgent("pitch", "user-1", {
      RATIONALE_CONTEXT: "You both love hiking.",
    });
    await agent.sendMessage("Why did you match us?");

    expect(mockRunAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("You both love hiking."),
      })
    );
    const { systemPrompt } = mockRunAgentQuery.mock.calls[0][0] as { systemPrompt: string };
    expect(systemPrompt).not.toContain("{{RATIONALE_CONTEXT}}");
  });

  it("treats a literal $ in the replacement value as literal text, not a regex pattern", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({ text: "ok", toolUses: [] });

    const agent = new BarneyAgent("pitch", "user-1", {
      RATIONALE_CONTEXT: "They make $$$ but that's not why you matched.",
    });
    await agent.sendMessage("Tell me more");

    expect(mockRunAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("They make $$$ but that's not why you matched."),
      })
    );
  });
});

describe("sendMessage", () => {
  it("returns the model's text reply", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({ text: "Nice to meet you!", toolUses: [] });

    const agent = new BarneyAgent("interview_self", "user-1");
    const reply = await agent.sendMessage("Hi Barney");

    expect(reply).toBe("Nice to meet you!");
  });

  it("does not pass mcpServers/allowedTools to the SDK for a mode with no registered tools", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({ text: "Tell me more.", toolUses: [] });

    const agent = new BarneyAgent("pitch", "user-1");
    await agent.sendMessage("It went okay.");

    expect(mockRunAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: undefined, allowedTools: undefined })
    );
  });

  it("grows the conversation transcript with each turn", async () => {
    const prompts: string[] = [];
    mockRunAgentQuery.mockImplementation(async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { text: "ok", toolUses: [] };
    });

    const agent = new BarneyAgent("interview_self", "user-1");
    await agent.sendMessage("First message");
    await agent.sendMessage("Second message");

    expect(prompts[0]).toContain("First message");
    expect(prompts[1]).toContain("First message");
    expect(prompts[1]).toContain("Second message");
  });

  it("selects the system prompt matching the agent's mode", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({ text: "ok", toolUses: [] });

    const agent = new BarneyAgent("pitch", "user-1");
    await agent.sendMessage("Tell me about my match");

    expect(mockRunAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: PROMPTS_BY_MODE.pitch })
    );
  });

  it("propagates errors from the agent query instead of swallowing them", async () => {
    mockRunAgentQuery.mockRejectedValueOnce(new Error("API unavailable"));

    const agent = new BarneyAgent("interview_self", "user-1");

    await expect(agent.sendMessage("Hi")).rejects.toThrow("API unavailable");
  });

  it("rolls back history after a failed turn so the session stays valid for the next message", async () => {
    mockRunAgentQuery.mockRejectedValueOnce(new Error("API unavailable"));
    const prompts: string[] = [];
    mockRunAgentQuery.mockImplementationOnce(async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { text: "ok", toolUses: [] };
    });

    const agent = new BarneyAgent("interview_self", "user-1");

    await expect(agent.sendMessage("First, will fail")).rejects.toThrow("API unavailable");
    await agent.sendMessage("Second, should still start clean");

    // If the failed turn's user message had not been rolled back, the second
    // prompt would still contain "First, will fail".
    expect(prompts[0]).not.toContain("First, will fail");
    expect(prompts[0]).toContain("Second, should still start clean");
  });

  it("rejects a second sendMessage call made before the first has resolved", async () => {
    let resolveFirstCall: (() => void) | undefined;
    mockRunAgentQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstCall = () => resolve({ text: "first reply", toolUses: [] });
        })
    );

    const agent = new BarneyAgent("interview_self", "user-1");
    const firstCall = agent.sendMessage("First message");

    await expect(agent.sendMessage("Second message")).rejects.toThrow(
      "sendMessage is already in progress"
    );

    resolveFirstCall?.();
    await expect(firstCall).resolves.toBe("first reply");
  });
});

describe("tool use", () => {
  it("runs the registered tool via the SDK handler and emits a toolCall event", async () => {
    mockEchoHandler.mockResolvedValue({ echoed: { foo: "bar" } });
    mockRunAgentQuery.mockImplementationOnce(
      async ({
        mcpServers,
      }: {
        mcpServers: { wingman: { tools: { handler: (i: unknown) => Promise<unknown> }[] } };
      }) => {
        // Simulate the SDK invoking our tool handler mid-turn, the way the real
        // agentic loop would, then returning the model's final text.
        await mcpServers.wingman.tools[0].handler({ foo: "bar" });
        return { text: "Got it, thanks!", toolUses: [] };
      }
    );

    const agent = new BarneyAgent("interview_self", "user-1");
    const toolCallListener = vi.fn();
    agent.on("toolCall", toolCallListener);

    const reply = await agent.sendMessage("Save my profile");

    expect(mockEchoHandler).toHaveBeenCalledWith({ foo: "bar" });
    expect(toolCallListener).toHaveBeenCalledWith({
      name: "echo",
      input: { foo: "bar" },
      result: { echoed: { foo: "bar" } },
    });
    expect(reply).toBe("Got it, thanks!");
  });

  it("throws when the turn ends without a final reply", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({ text: "", toolUses: [] });

    const agent = new BarneyAgent("interview_self", "user-1");

    await expect(agent.sendMessage("Keep going forever")).rejects.toThrow(
      "exceeded max tool-use iterations"
    );
  });
});

describe("debrief tool wiring (#75)", () => {
  it("passes the session's matchId and the transcript so far to the tool factory", async () => {
    mockRunAgentQuery.mockImplementationOnce(
      async ({
        mcpServers,
      }: {
        mcpServers: { wingman: { tools: { handler: (i: unknown) => Promise<unknown> }[] } };
      }) => {
        await mcpServers.wingman.tools[0].handler({});
        return { text: "Got it, thanks for walking me through that.", toolUses: [] };
      }
    );

    const agent = new BarneyAgent("debrief", "user-1", { DATE_CONTEXT: "..." }, "match-1");
    await agent.sendMessage("It went okay.");

    expect(mockDebriefFactory).toHaveBeenCalledWith(
      "user-1",
      expect.any(Function),
      expect.objectContaining({
        matchId: "match-1",
        transcript: expect.stringContaining("It went okay."),
      })
    );
  });

  it("rebuilds the transcript passed to the tool factory on every turn", async () => {
    mockRunAgentQuery.mockResolvedValue({ text: "ok", toolUses: [] });

    const agent = new BarneyAgent("debrief", "user-1", undefined, "match-1");
    await agent.sendMessage("First thing");
    await agent.sendMessage("Second thing");

    const lastCall = mockDebriefFactory.mock.calls.at(-1);
    expect(lastCall?.[2]).toMatchObject({
      transcript: expect.stringContaining("Second thing"),
    });
  });
});
