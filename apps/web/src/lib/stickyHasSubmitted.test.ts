import { describe, it, expect } from "vitest";
import { stickyHasSubmitted } from "./stickyHasSubmitted";

describe("stickyHasSubmitted", () => {
  it("adopts a fresh true from the server", () => {
    expect(stickyHasSubmitted(false, true)).toBe(true);
  });

  it("stays false while the server hasn't reported a submission yet", () => {
    expect(stickyHasSubmitted(false, false)).toBe(false);
    expect(stickyHasSubmitted(false, undefined)).toBe(false);
    expect(stickyHasSubmitted(false, null)).toBe(false);
  });

  // #547 — a stale poll response that resolves after a submit already flipped
  // local state to true must not knock the proposer back to the picker.
  it("does not let a stale false flip a submitted proposer back to the picker", () => {
    expect(stickyHasSubmitted(true, false)).toBe(true);
    expect(stickyHasSubmitted(true, undefined)).toBe(true);
    expect(stickyHasSubmitted(true, null)).toBe(true);
  });

  it("stays true once submitted, for a later true poll too", () => {
    expect(stickyHasSubmitted(true, true)).toBe(true);
  });
});
