import { tool } from "@anthropic-ai/claude-agent-sdk";
import { GroundednessJudgeInputSchema } from "@wingman/shared";
import type { GroundednessJudgeInput } from "@wingman/shared";

const SAVE_GROUNDEDNESS_DESCRIPTION =
  "Call this once, after reviewing every statement, to report how many factual claims the agent made about its own human and which of those the profile does not support. Report totalClaims as the count of factual claims you examined, and list only the unsupported ones in ungroundedClaims.";

// Structured capture for the groundedness judge's verdict (issue #336) —
// consistent with saveScore/saveProfile per docs/adr/0007 §3. No DB write: the
// eval runner (Track 2) persists the combined result on the Track2PairResult.
//
// The Agent SDK has no forced tool_choice (see docs/adr/0011), so
// judgeGroundedness prompts the model to call this and throws if it never does.
// `onGroundedness` lets the caller capture the validated input the moment the
// SDK invokes this handler.
export function createSaveGroundednessTool(
  onGroundedness: (input: GroundednessJudgeInput) => void
) {
  return tool(
    "saveGroundedness",
    SAVE_GROUNDEDNESS_DESCRIPTION,
    GroundednessJudgeInputSchema.shape,
    async (input) => {
      onGroundedness(input);
      return { content: [{ type: "text" as const, text: "recorded" }] };
    }
  );
}
