import { describe, expect, it } from "vitest";
import {
  afterTurn,
  canAsk,
  parseStoredPitchCounter,
  questionsLeft,
  TOTAL_QUESTIONS,
} from "./pitchCounter";

describe("the Genie Mechanic allowance", () => {
  it("is the three questions ADR-0013 specifies", () => {
    expect(TOTAL_QUESTIONS).toBe(3);
  });

  it("counts down as questions land", () => {
    expect(questionsLeft(0)).toBe(3);
    expect(questionsLeft(1)).toBe(2);
    expect(questionsLeft(2)).toBe(1);
    expect(questionsLeft(3)).toBe(0);
  });

  // The whole point of the mechanic: Barney is never told to stop, so this is
  // the only thing standing between the user and a 4th question.
  it("never reports a fourth question as available", () => {
    expect(questionsLeft(4)).toBe(0);
    expect(questionsLeft(99)).toBe(0);
    expect(canAsk(3, false)).toBe(false);
    expect(canAsk(4, false)).toBe(false);
  });
});

describe("canAsk", () => {
  it("allows a question while the allowance holds and nothing is in flight", () => {
    expect(canAsk(0, false)).toBe(true);
    expect(canAsk(2, false)).toBe(true);
  });

  // Mirrors useBarneyChat's own gate. Without this a double-tap during a reply
  // would spend two questions on one answer.
  it("refuses while a turn is still in flight", () => {
    expect(canAsk(0, true)).toBe(false);
    expect(canAsk(2, true)).toBe(false);
  });
});

describe("afterTurn", () => {
  it("spends a question on a turn that landed", () => {
    expect(afterTurn(0, true)).toBe(1);
    expect(afterTurn(2, true)).toBe(3);
  });

  // useBarneyChat leaves the user's message in the transcript when a turn
  // fails, so anything counting sent messages would charge the user for the
  // api being unreachable.
  it("does not spend a question on a turn that failed", () => {
    expect(afterTurn(0, false)).toBe(0);
    expect(afterTurn(2, false)).toBe(2);
  });

  it("cannot be pushed past the allowance", () => {
    expect(afterTurn(3, true)).toBe(3);
  });

  it("walks the full allowance down to zero and stops", () => {
    let asked = 0;
    for (let i = 0; i < 5; i++) asked = afterTurn(asked, true);
    expect(asked).toBe(TOTAL_QUESTIONS);
    expect(questionsLeft(asked)).toBe(0);
    expect(canAsk(asked, false)).toBe(false);
  });
});

describe("parseStoredPitchCounter", () => {
  const session = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";

  it("reads back a count stored against the same conversation", () => {
    expect(parseStoredPitchCounter(JSON.stringify({ sessionId: session, asked: 2 }), session)).toBe(
      2
    );
  });

  // The reason this is keyed by session at all: a new conversation starts with
  // a full allowance, and the stale record must not follow the user into it.
  it("ignores a count from a different conversation", () => {
    expect(parseStoredPitchCounter(JSON.stringify({ sessionId: other, asked: 3 }), session)).toBe(
      0
    );
  });

  it("treats nothing stored as nothing spent", () => {
    expect(parseStoredPitchCounter(null, session)).toBe(0);
  });

  it.each([
    ["not json", "{oh no"],
    ["the wrong shape", JSON.stringify({ asked: 2 })],
    ["a non-numeric count", JSON.stringify({ sessionId: session, asked: "two" })],
    ["a negative count", JSON.stringify({ sessionId: session, asked: -1 })],
  ])("opens the pitch rather than failing on %s", (_label, raw) => {
    expect(parseStoredPitchCounter(raw, session)).toBe(0);
  });

  // The ceiling matters more than the floor: a count above the allowance would
  // make questionsLeft report a negative number of questions.
  it("clamps a count above the allowance", () => {
    expect(parseStoredPitchCounter(JSON.stringify({ sessionId: session, asked: 9 }), session)).toBe(
      TOTAL_QUESTIONS
    );
  });
});
