import { z } from "zod";

// Structured output of one debrief (issue #71, #74): adjustments to a user's
// WantedProfile Negotiation Fields (dealbreakers, preferences, compromises)
// learned from how a Blind Date actually went. #76 merges every
// FeedbackRound.delta for a user, oldest to newest, into future negotiation
// context. `removedDealbreakers` (#341) lets a later debrief retract a
// dealbreaker an earlier one added — mirrors `removedPreferences`'s existing
// retraction shape for `addedPreferences`.
export const FeedbackDeltaSchema = z.object({
  addedDealbreakers: z.array(z.string()),
  removedDealbreakers: z.array(z.string()).default([]),
  removedPreferences: z.array(z.string()),
  addedPreferences: z.array(z.string()),
  compromiseUpdates: z.array(z.string()),
});

export type FeedbackDelta = z.infer<typeof FeedbackDeltaSchema>;
