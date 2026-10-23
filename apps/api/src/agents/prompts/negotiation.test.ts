import { describe, expect, it } from "vitest";
import { NEGOTIATION_PROMPT } from "./negotiation";

describe("NEGOTIATION_PROMPT", () => {
  it("is a showcase placeholder that still has a profile slot", () => {
    expect(NEGOTIATION_PROMPT).toContain("Prompt redacted in the public showcase version");
    expect(NEGOTIATION_PROMPT).toContain("{{PROFILE_CONTEXT}}");
    expect(NEGOTIATION_PROMPT).not.toMatch(/dealbreaker/i);
    expect(NEGOTIATION_PROMPT).not.toMatch(/rubric/i);
  });
});
