import { tool } from "@anthropic-ai/claude-agent-sdk";
import { NegotiationScoreInputSchema } from "@wingman/shared";

const SAVE_SCORE_DESCRIPTION =
  "Call this once after negotiation to report a 1-10 score and a short rationale.";

// Structured capture for the negotiation agent's independent score —
// consistent with saveProfile/saveWantedProfile per docs/adr/0007 §3. No DB
// write: negotiation never touches the database (see #40); the caller
// persists scoreA/scoreB on the Match record (#42).
//
// The Agent SDK has no forced tool_choice (see docs/adr/0011), so
// NegotiationAgent.score() prompts the model to call this and re-asks once if
// it doesn't. `onScore` lets the caller capture the validated input the
// moment the SDK invokes this handler.
export function createSaveScoreTool(
  onScore: (input: { score: number; rationale: string }) => void
) {
  return tool(
    "saveScore",
    SAVE_SCORE_DESCRIPTION,
    NegotiationScoreInputSchema.shape,
    async (input) => {
      onScore(input);
      return { content: [{ type: "text" as const, text: "recorded" }] };
    }
  );
}
