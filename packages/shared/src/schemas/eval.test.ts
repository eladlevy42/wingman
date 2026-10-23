import { describe, expect, it } from "vitest";
import { EvalRunConfigSchema, GroundednessFlagSchema } from "./eval";

describe("EvalRunConfigSchema", () => {
  it("accepts an even turns value", () => {
    expect(EvalRunConfigSchema.parse({ turns: 4 }).turns).toBe(4);
  });

  it("rejects an odd turns value — negotiation turns alternate strictly A/B", () => {
    expect(() => EvalRunConfigSchema.parse({ turns: 5 })).toThrow(/turns must be even/);
  });

  it("applies default model tiers when omitted", () => {
    const config = EvalRunConfigSchema.parse({});
    expect(config.barneyModel).toBe("sonnet");
    expect(config.judgeModel).toBe("sonnet");
  });
});

describe("GroundednessFlagSchema", () => {
  it("defaults kind to 'self' when omitted — pre-#420 rows and the saveGroundedness tool", () => {
    const flag = GroundednessFlagSchema.parse({ claim: "likes hiking", reason: "not in profile" });
    expect(flag.kind).toBe("self");
  });

  it("accepts an explicit 'about-other' kind (issue #420 cross-profile pass)", () => {
    const flag = GroundednessFlagSchema.parse({
      claim: "is a software engineer",
      reason: "profile says chef",
      kind: "about-other",
    });
    expect(flag.kind).toBe("about-other");
  });
});
