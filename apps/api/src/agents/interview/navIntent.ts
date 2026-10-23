// Cheap keyword heuristics (consistent with docs/adr/0004's "a few hardcoded
// branches triggered only by cheap heuristics") that let a user steer the
// deterministic interview flow with plain phrases — skip the current question or
// step back to the previous one — without spending a model call to detect intent.
//
// Both matchers deliberately fire only when the WHOLE message is a navigation
// command (after trimming trailing punctuation). This avoids false positives
// like "I want to continue my studies" (a real answer that merely contains
// "continue") being mistaken for a skip.

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SKIP_PHRASES = new Set([
  "skip",
  "skip this",
  "skip it",
  "skip this one",
  "skip question",
  "next",
  "next question",
  "next one",
  "continue",
  "continue please",
  "move on",
  "let's move on",
  "lets move on",
  "move on please",
  "pass",
  "go on",
  "keep going",
  "i'd rather not say",
  "id rather not say",
  "i'd rather not answer",
  "id rather not answer",
  "prefer not to say",
  "no comment",
  // Hebrew (ADR-0037). Same rule as the English set: the whole message must be
  // the command. toLowerCase() is a no-op on Hebrew, which has no case, so the
  // entries are written exactly as they are typed.
  "דלג",
  "דלגי",
  "דלג על זה",
  "דלג על השאלה",
  "תדלג",
  "הבא",
  "השאלה הבאה",
  "הלאה",
  "ממשיכים",
  "בוא נמשיך",
  "תמשיך",
  "נמשיך",
  "אין לי תשובה",
  "מעדיף לא לענות",
  "מעדיפה לא לענות",
  "לא רוצה לענות",
  "בלי תשובה",
]);

// True when the user is explicitly asking to move past the current question
// without answering it.
export function looksLikeSkip(text: string): boolean {
  return SKIP_PHRASES.has(normalize(text));
}

const BACK_PHRASES = new Set([
  "back",
  "go back",
  "go back please",
  "previous",
  "prev",
  "previous question",
  "last question",
  "undo",
  "let me go back",
  "i want to go back",
  "can i go back",
  "change my answer",
  "change my previous answer",
  "change my last answer",
  "let me redo that",
  "redo",
  // Hebrew (ADR-0037).
  "חזור",
  "חזרה",
  "אחורה",
  "חזור אחורה",
  "תחזור אחורה",
  "השאלה הקודמת",
  "הקודמת",
  "בוא נחזור",
  "אני רוצה לחזור",
  "לשנות את התשובה",
  "לשנות תשובה",
  "רוצה לשנות את התשובה",
  "בטל",
]);

// True when the user wants to return to the previous question to change or
// correct an answer.
export function looksLikeBack(text: string): boolean {
  return BACK_PHRASES.has(normalize(text));
}
