import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunAgentQuery } = vi.hoisted(() => ({ mockRunAgentQuery: vi.fn() }));

vi.mock("../agentSdkClient", () => ({ runAgentQuery: mockRunAgentQuery }));

import { INTERVIEW_HELPER_MODEL } from "../models";
import { answerSideQuestion, looksLikeQuestion } from "./sideQuestion";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("looksLikeQuestion", () => {
  it("is true for an answer ending in a question mark", () => {
    expect(looksLikeQuestion("why do you need that?")).toBe(true);
  });

  it("is true even with trailing whitespace", () => {
    expect(looksLikeQuestion("why do you need that?  ")).toBe(true);
  });

  it("is false for a normal answer", () => {
    expect(looksLikeQuestion("Tel Aviv")).toBe(false);
  });

  it("is false for an answer that merely mentions a question mark mid-sentence", () => {
    expect(looksLikeQuestion("is that ok? I'm 30")).toBe(false);
  });
});

describe("answerSideQuestion", () => {
  it("returns the agent query's text, trimmed", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({
      text: "  We ask so we can match you nearby. So — which city do you live in?  ",
      toolUses: [],
    });

    const result = await answerSideQuestion({
      pendingQuestion: "Which city do you live in?",
      userQuestion: "why do you need that?",
      language: "en",
      userId: "u-1",
    });

    expect(result).toBe("We ask so we can match you nearby. So — which city do you live in?");
    expect(mockRunAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ logLabel: "sideQuestion", model: INTERVIEW_HELPER_MODEL })
    );
  });

  it("propagates errors from the agent query", async () => {
    mockRunAgentQuery.mockRejectedValueOnce(new Error("network timeout"));

    await expect(
      answerSideQuestion({
        pendingQuestion: "Which city?",
        userQuestion: "why?",
        language: "en",
        userId: "u-1",
      })
    ).rejects.toThrow("network timeout");
  });
});
