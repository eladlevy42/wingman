import { describe, it, expect } from "vitest";
import { NegotiationResultSchema, NegotiationMessageSchema } from "./negotiation";

describe("NegotiationResultSchema rationale fields", () => {
  it("accepts per-agent score rationales and allows null", () => {
    const parsed = NegotiationResultSchema.parse({
      deliberationLog: [],
      scoreA: 8,
      scoreB: 7,
      matched: true,
      rationale: "warm summary",
      rationaleA: "A's reasoning for 8",
      rationaleB: null,
    });
    expect(parsed.rationaleA).toBe("A's reasoning for 8");
    expect(parsed.rationaleB).toBeNull();
  });
});

describe("NegotiationMessageSchema thinking field", () => {
  it("allows an optional per-turn thinking field on a message", () => {
    const m = NegotiationMessageSchema.parse({
      speaker: "Alex's agent",
      content: "A synthetic turn.",
      thinking: "a synthetic note",
    });
    expect(m.thinking).toContain("synthetic");
    // thinking is optional
    expect(NegotiationMessageSchema.parse({ speaker: "x", content: "y" }).thinking).toBeUndefined();
  });
});
