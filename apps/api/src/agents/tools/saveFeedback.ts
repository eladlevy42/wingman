import { tool } from "@anthropic-ai/claude-agent-sdk";
import { FeedbackDeltaSchema, type FeedbackDelta } from "@wingman/shared";
import { prisma } from "@wingman/database";

const SAVE_FEEDBACK_DESCRIPTION =
  "Call this once at the end of the debrief with the structured feedback.";

// Persists one debrief's structured delta as a FeedbackRound row (CONTEXT.md
// "FeedbackRound", "FeedbackDelta"). Re-validates with FeedbackDeltaSchema
// rather than trusting the caller, unlike persistProfile — see docs/adr/0018.
export async function persistFeedback(
  userId: string,
  matchId: string,
  rawTranscript: string,
  input: unknown
) {
  const delta = FeedbackDeltaSchema.parse(input);
  const serializedDelta = JSON.stringify(delta);

  // upsert, not create: FeedbackRound has @@unique([userId, matchId]), and a
  // retried tool call for the same match is a known LLM failure mode (see
  // MAX_TOOL_ITERATIONS in barney.agent.ts) that create() would crash on.
  const feedbackRound = await prisma.feedbackRound.upsert({
    where: { userId_matchId: { userId, matchId } },
    update: {
      rawTranscript,
      delta: serializedDelta,
    },
    create: {
      userId,
      matchId,
      rawTranscript,
      delta: serializedDelta,
    },
  });

  return { success: true, feedbackRoundId: feedbackRound.id };
}

// `matchId` and `rawTranscript` are supplied by the caller at tool-creation
// time, never by the model — FeedbackDeltaSchema (docs/adr/0017) has no such
// fields. Not wired into TOOL_FACTORIES_BY_MODE yet: #75 owns deciding how a
// live debrief session supplies these two values (docs/adr/0018).
export function createSaveFeedbackTool(
  userId: string,
  matchId: string,
  rawTranscript: string,
  onSaved: (input: FeedbackDelta, result: unknown) => void
) {
  return tool(
    "saveFeedback",
    SAVE_FEEDBACK_DESCRIPTION,
    FeedbackDeltaSchema.shape,
    async (input) => {
      const result = await persistFeedback(userId, matchId, rawTranscript, input);
      onSaved(input, result);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}
