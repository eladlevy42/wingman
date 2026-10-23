import { describe, it, expect, vi } from "vitest";
import { createSaveScoreTool } from "./saveScore";

describe("createSaveScoreTool", () => {
  it("is named saveScore and requires score and rationale in its schema shape", () => {
    const scoreTool = createSaveScoreTool(vi.fn());
    expect(scoreTool.name).toBe("saveScore");
    expect(Object.keys(scoreTool.inputSchema)).toEqual(["score", "rationale"]);
  });

  it("invokes onScore with the validated input and returns a recorded result", async () => {
    const onScore = vi.fn();
    const scoreTool = createSaveScoreTool(onScore);

    const result = await scoreTool.handler({ score: 8, rationale: "Solid alignment." }, undefined);

    expect(onScore).toHaveBeenCalledWith({ score: 8, rationale: "Solid alignment." });
    expect(result).toEqual({ content: [{ type: "text", text: "recorded" }] });
  });
});
