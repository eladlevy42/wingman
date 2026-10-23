import type { EvalModel } from "@wingman/shared";

// The single source of truth for every model id in the codebase (#303): no
// bare "claude-..." model id may appear in any other non-test file — agents
// and helpers import these constants. Every id here was verified live against
// the API before landing (a guessed id fails at call time with
// model_not_found: "claude-haiku-4-6" never existed, which is how the
// pre-#303 tier map learned this lesson).

// The two production agents (docs/adr/0011): the Skeptical Advocates that
// negotiate matches, and Barney (interview / pitch / debrief persona).
// #303 trialed claude-sonnet-5 for both, gated by before/after eval runs
// recorded in the PR. The verdict split: negotiation REGRESSED under Sonnet 5
// on Track 2 (fewer good pairs matched, judge mean 3.76 -> 2.62), so it stays
// on 4-6 per the agreed revert policy; Barney's Track 3 extraction clearly
// improved (19.3% -> 25.1% fields, saveProfile fired 76% -> 100%), so Barney
// keeps Sonnet 5. Deliberately two dials — re-judge each on its own eval.
export const NEGOTIATION_MODEL = "claude-sonnet-4-6";
export const BARNEY_MODEL = "claude-sonnet-5";

// The cheap single-purpose interview helpers (softTurn, sideQuestion,
// addendum — docs/adr/0004): one narrow judgment per call, so the smallest
// current model. There is no Claude 5 Haiku yet; 4-5 is the newest.
export const INTERVIEW_HELPER_MODEL = "claude-haiku-4-5-20251001";

// Maps the eval dashboard's model-tier picker (#250) to real model ids.
// "sonnet" is deliberately derived from the production negotiation agent's
// model so a Track 2 run left at the default always reproduces production
// negotiation behavior exactly.
export const EVAL_MODEL_IDS: Record<EvalModel, string> = {
  haiku: INTERVIEW_HELPER_MODEL,
  sonnet: NEGOTIATION_MODEL,
  opus: "claude-opus-4-8",
};
