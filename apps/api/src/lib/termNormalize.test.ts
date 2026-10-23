import { describe, expect, it } from "vitest";
import { canonicalizeTerm, normalizeTerm } from "./termNormalize";

describe("normalizeTerm", () => {
  it("lowercases, trims, and collapses inner whitespace", () => {
    expect(normalizeTerm("  Hiking ")).toBe("hiking");
    expect(normalizeTerm("Rock  Climbing")).toBe("rock climbing");
  });

  it("does not stem or merge synonyms in the showcase build", () => {
    expect(normalizeTerm("hiking")).not.toBe(normalizeTerm("hikes"));
    expect(canonicalizeTerm("cooking")).not.toBe(canonicalizeTerm("baking"));
  });
});
