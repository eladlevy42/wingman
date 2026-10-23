import { describe, expect, it } from "vitest";
import {
  BarneyMessageInputSchema,
  BarneySessionInputSchema,
  MAX_MESSAGE_LENGTH,
  MESSAGE_LENGTH_COUNTER_FROM,
} from "./barney";

describe("BarneySessionInputSchema", () => {
  it("accepts a non-pitch mode without a matchId", () => {
    const result = BarneySessionInputSchema.safeParse({
      userId: "user-1",
      mode: "interview_self",
    });

    expect(result.success).toBe(true);
  });

  it("accepts pitch mode with a matchId", () => {
    const result = BarneySessionInputSchema.safeParse({
      userId: "user-1",
      mode: "pitch",
      matchId: "match-1",
    });

    expect(result.success).toBe(true);
  });

  it("rejects pitch mode without a matchId", () => {
    const result = BarneySessionInputSchema.safeParse({
      userId: "user-1",
      mode: "pitch",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty-string matchId for pitch mode", () => {
    const result = BarneySessionInputSchema.safeParse({
      userId: "user-1",
      mode: "pitch",
      matchId: "",
    });

    expect(result.success).toBe(false);
  });

  it("accepts debrief mode with a matchId", () => {
    const result = BarneySessionInputSchema.safeParse({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });

    expect(result.success).toBe(true);
  });

  it("rejects debrief mode without a matchId", () => {
    const result = BarneySessionInputSchema.safeParse({
      userId: "user-1",
      mode: "debrief",
    });

    expect(result.success).toBe(false);
  });
});

describe("BarneyMessageInputSchema", () => {
  it("accepts a normal-length message", () => {
    const result = BarneyMessageInputSchema.safeParse({
      sessionId: "session-1",
      message: "I love hiking on weekends.",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a message over the max length", () => {
    const result = BarneyMessageInputSchema.safeParse({
      sessionId: "session-1",
      message: "a".repeat(4001),
    });

    expect(result.success).toBe(false);
  });

  // #493: the bound was enforced here and nowhere else, so an over-length answer
  // reached the server, came back a 400, and surfaced as "Something went wrong.
  // Please try again." with the typed text already discarded. The composers now
  // cap the input at MAX_MESSAGE_LENGTH and show a counter from
  // MESSAGE_LENGTH_COUNTER_FROM onwards, so these two have to stay coherent.
  it("accepts a message of exactly the max length", () => {
    const result = BarneyMessageInputSchema.safeParse({
      sessionId: "session-1",
      message: "a".repeat(MAX_MESSAGE_LENGTH),
    });

    expect(result.success).toBe(true);
  });

  it("starts counting before the cap, leaving room to notice it", () => {
    expect(MESSAGE_LENGTH_COUNTER_FROM).toBeLessThan(MAX_MESSAGE_LENGTH);
    expect(MESSAGE_LENGTH_COUNTER_FROM).toBeGreaterThan(0);
  });
});
