import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ConsistencyVerdictSchema, type ConsistencyVerdict } from "@wingman/shared";

const SAVE_CONSISTENCY_VERDICT_DESCRIPTION =
  "Call this once to report whether each side's score is consistent with the transcript.";

// Structured capture for the Dealbreaker Gate consistency judge (issue #337) —
// mirrors saveScore's tool-per-caller shape (docs/adr/0007 §3). Eval-only:
// used solely by consistencyJudge.agent.ts's Track 2 auditor pass, never by a
// production agent.
export function createSaveConsistencyVerdictTool(onVerdict: (input: ConsistencyVerdict) => void) {
  return tool(
    "saveConsistencyVerdict",
    SAVE_CONSISTENCY_VERDICT_DESCRIPTION,
    ConsistencyVerdictSchema.shape,
    async (input) => {
      onVerdict(input);
      return { content: [{ type: "text" as const, text: "recorded" }] };
    }
  );
}
