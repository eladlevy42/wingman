import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GroundednessJudgeInput } from "@wingman/shared";

const { mockRunAgentQuery } = vi.hoisted(() => ({ mockRunAgentQuery: vi.fn() }));

vi.mock("./agentSdkClient", () => ({ runAgentQuery: mockRunAgentQuery }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((options) => options),
}));

// Captures the callback each time judgeGroundedness wires up a
// saveGroundedness tool, so the runAgentQuery mock can simulate the SDK
// invoking it (or not, to exercise the failure path).
let lastOnGroundedness: ((input: GroundednessJudgeInput) => void) | undefined;
vi.mock("./tools/saveGroundedness", () => ({
  createSaveGroundednessTool: vi.fn((onGroundedness: (input: GroundednessJudgeInput) => void) => {
    lastOnGroundedness = onGroundedness;
    return { name: "saveGroundedness" };
  }),
}));

import { judgeGroundedness } from "./groundednessJudge.agent";

// A profile that says nothing about the human being vegan or a marathon runner.
const PROFILE_JSON = JSON.stringify(
  {
    gender: "female",
    userProfile: { age: 30, city: "Tel Aviv", hobbies: ["reading"], job: "teacher" },
    wantedProfile: { dealbreakers: ["smoking"], preferences: ["kind"] },
  },
  null,
  2
);

beforeEach(() => {
  vi.clearAllMocks();
  lastOnGroundedness = undefined;
});

describe("judgeGroundedness", () => {
  it("returns the judge's verdict, flagging a claim the profile does not support", async () => {
    mockRunAgentQuery.mockImplementationOnce(async () => {
      lastOnGroundedness?.({
        totalClaims: 3,
        ungroundedClaims: [
          {
            claim: "She is a vegan marathon runner",
            reason: "Profile lists no diet or running",
            kind: "self",
          },
        ],
      });
      return { text: "", toolUses: [], costUsd: 0.003, durationMs: 250 };
    });

    const result = await judgeGroundedness(
      "Dana",
      PROFILE_JSON,
      [
        "My human is a 30-year-old teacher in Tel Aviv.",
        "She loves reading in her free time.",
        "She is a vegan marathon runner.",
      ],
      "claude-haiku"
    );

    expect(result.totalClaims).toBe(3);
    expect(result.ungroundedClaims).toHaveLength(1);
    expect(result.ungroundedClaims[0].claim).toContain("vegan marathon runner");
    expect(result.costUsd).toBeCloseTo(0.003);
    expect(result.durationMs).toBe(250);
  });

  it("passes the profile and the speaker's claims into the judge prompt", async () => {
    mockRunAgentQuery.mockImplementationOnce(async () => {
      lastOnGroundedness?.({ totalClaims: 1, ungroundedClaims: [] });
      return { text: "", toolUses: [], costUsd: 0, durationMs: 0 };
    });

    await judgeGroundedness("Dana", PROFILE_JSON, ["She loves reading."], "claude-haiku");

    const [args] = mockRunAgentQuery.mock.calls[0];
    expect(args.prompt).toContain("Dana");
    expect(args.prompt).toContain("teacher");
    expect(args.prompt).toContain("She loves reading.");
    expect(args.allowedTools).toEqual(["mcp__wingman__saveGroundedness"]);
  });

  it("short-circuits with no API call when the speaker made no claims", async () => {
    const result = await judgeGroundedness("Dana", PROFILE_JSON, [], "claude-haiku");

    expect(result).toEqual({ totalClaims: 0, ungroundedClaims: [], costUsd: 0, durationMs: 0 });
    expect(mockRunAgentQuery).not.toHaveBeenCalled();
  });

  it("throws when the model never calls saveGroundedness", async () => {
    mockRunAgentQuery.mockImplementationOnce(async () => ({
      text: "I refuse to use tools.",
      toolUses: [],
      costUsd: 0.001,
      durationMs: 100,
    }));

    await expect(
      judgeGroundedness("Dana", PROFILE_JSON, ["some claim"], "claude-haiku")
    ).rejects.toThrow(/did not call saveGroundedness/i);
  });
});
