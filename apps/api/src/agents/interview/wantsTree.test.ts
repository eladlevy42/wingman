import { describe, it, expect } from "vitest";
import { INTERVIEW_WANTS_TREE } from "./wantsTree";

// Dealbreaker guidance is redacted in the public showcase version.
describe("INTERVIEW_WANTS_TREE dealbreakers node", () => {
  const node = INTERVIEW_WANTS_TREE.find((n) => n.field === "dealbreakers");
  it("exists and is a soft node", () => {
    expect(node).toBeDefined();
    expect(node?.kind).toBe("soft");
  });
  if (!node || node.kind !== "soft") throw new Error("dealbreakers node not found or not soft");
  const dealbreakers = node;

  it("does not use an unverifiable topic (smoking) as its extraction example", () => {
    expect(dealbreakers.extractHint?.toLowerCase()).not.toContain("smoking");
  });

  it("keeps dealbreaker guidance redacted", () => {
    expect(dealbreakers.sufficiencyGuidance).toBe("Redacted.");
    expect(dealbreakers.extractHint).toBe("Redacted.");
    expect(dealbreakers.extractHint?.toLowerCase()).not.toContain("smoking");
  });
});
