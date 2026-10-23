import { describe, it, expect } from "vitest";
import { looksLikeSkip, looksLikeBack } from "./navIntent";

describe("looksLikeSkip", () => {
  it("matches plain skip/next/continue commands, case- and punctuation-insensitive", () => {
    for (const t of ["skip", "Skip.", "NEXT", "next question", "continue", "Move on!", "pass"]) {
      expect(looksLikeSkip(t)).toBe(true);
    }
  });

  it("does NOT match a real answer that merely contains a skip word", () => {
    for (const t of [
      "I want to continue my studies",
      "my next goal is a startup",
      "I'll pass on kids for now",
      "moving on from my ex taught me a lot",
    ]) {
      expect(looksLikeSkip(t)).toBe(false);
    }
  });
});

describe("looksLikeBack", () => {
  it("matches plain back/previous commands", () => {
    for (const t of ["back", "Go back", "previous", "previous question", "change my answer"]) {
      expect(looksLikeBack(t)).toBe(true);
    }
  });

  it("does NOT match an answer that merely contains a back word", () => {
    for (const t of [
      "I have a background in biology",
      "I'd go back to Rome in a heartbeat",
      "my previous relationship was long",
    ]) {
      expect(looksLikeBack(t)).toBe(false);
    }
  });
});

// ADR-0037 — the same steering phrases a Hebrew-speaking user would actually
// type. Without these, "דלג" is treated as an answer to the pending question.
describe("navigation intents — Hebrew (ADR-0037)", () => {
  it("recognizes Hebrew skip phrases", () => {
    for (const phrase of ["דלג", "הבא", "הלאה", "מעדיף לא לענות", "בוא נמשיך"]) {
      expect(looksLikeSkip(phrase)).toBe(true);
    }
  });

  it("recognizes Hebrew back phrases", () => {
    for (const phrase of ["חזור", "אחורה", "חזור אחורה", "השאלה הקודמת", "לשנות את התשובה"]) {
      expect(looksLikeBack(phrase)).toBe(true);
    }
  });

  it("does NOT match a Hebrew answer that merely contains a navigation word", () => {
    expect(looksLikeSkip("אני אוהב לדלג על ארוחת בוקר")).toBe(false);
    expect(looksLikeBack("חזרתי לארץ אחרי שנתיים")).toBe(false);
  });
});
