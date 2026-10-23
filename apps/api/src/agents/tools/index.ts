import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { BarneyMode, UserProfile } from "@wingman/shared";
import { createSaveProfileTool } from "./saveProfile";
import { createSaveFeedbackTool } from "./saveFeedback";

export type ToolCallEvent = { name: string; input: unknown; result: unknown };

// Per-turn data a tool factory can't get from userId alone. Only debrief's
// saveFeedback tool needs these today (docs/adr/0018) — matchId comes from
// the session (BarneyAgent's constructor), transcript is the conversation so
// far, rebuilt by BarneyAgent on every turn.
export type ToolFactoryContext = { matchId?: string; transcript?: string };

// Factories, not static instances: each SDK tool closes over the session's
// userId and the callback used to emit BarneyAgent's "toolCall" event, so a
// fresh set is built per BarneyAgent instance. See docs/adr/0011.
export type ToolFactory = (
  userId: string,
  onToolCall: (event: ToolCallEvent) => void,
  context: ToolFactoryContext
  // any: SdkMcpToolDefinition's handler is contravariant in its zod shape, so
  // a heterogeneous array of per-mode tools needs the type-erased form.
) => SdkMcpToolDefinition<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const TOOL_FACTORIES_BY_MODE: Record<BarneyMode, ToolFactory[]> = {
  interview_self: [
    (userId, onToolCall) =>
      createSaveProfileTool(userId, (input: UserProfile, result) =>
        onToolCall({ name: "saveProfile", input, result })
      ),
  ],
  interview_wants: [], // saveWantedProfile: #27
  pitch: [],
  debrief: [
    (userId, onToolCall, context) => {
      // Guaranteed present: BarneySessionInputSchema requires matchId for
      // debrief, and BarneyAgent rebuilds the transcript on every turn before
      // building tools — see barney.agent.ts sendMessage().
      if (!context.matchId || context.transcript === undefined) {
        throw new Error("debrief's saveFeedback tool requires matchId and transcript");
      }
      return createSaveFeedbackTool(userId, context.matchId, context.transcript, (input, result) =>
        onToolCall({ name: "saveFeedback", input, result })
      );
    },
  ],
};
