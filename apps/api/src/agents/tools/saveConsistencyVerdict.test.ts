import { describe, it, expect, vi } from "vitest";
import { createSaveConsistencyVerdictTool } from "./saveConsistencyVerdict";

describe("createSaveConsistencyVerdictTool", () => {
  it("is named saveConsistencyVerdict and requires both sides' verdicts plus an explanation", () => {
    const verdictTool = createSaveConsistencyVerdictTool(vi.fn());
    expect(verdictTool.name).toBe("saveConsistencyVerdict");
    expect(Object.keys(verdictTool.inputSchema)).toEqual([
      "aDealbreakerViolated",
      "aConsistent",
      "bDealbreakerViolated",
      "bConsistent",
      "explanation",
    ]);
  });

  it("invokes onVerdict with the validated input and returns a recorded result", async () => {
    const onVerdict = vi.fn();
    const verdictTool = createSaveConsistencyVerdictTool(onVerdict);
    const input = {
      aDealbreakerViolated: true,
      aConsistent: false,
      bDealbreakerViolated: false,
      bConsistent: true,
      explanation: "Side A's smoking dealbreaker was never resolved.",
    };

    const result = await verdictTool.handler(input, undefined);

    expect(onVerdict).toHaveBeenCalledWith(input);
    expect(result).toEqual({ content: [{ type: "text", text: "recorded" }] });
  });
});
