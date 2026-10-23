import { prisma } from "@wingman/database";
import { FeedbackDeltaSchema } from "@wingman/shared";
import type { FeedbackDelta } from "@wingman/shared";

// Merges every FeedbackRound.delta for a user (issue #76), oldest to newest, into
// one flat FeedbackDelta injected alongside WantedProfile at negotiation time.
// Dealbreakers and preferences are each resolved last-write-wins per term
// (#355): every round's add/remove for a given term overwrites that term's
// prior action, so whichever round most recently mentioned a term decides
// whether it ends up added or removed — a round-1 removal no longer
// permanently outlasts a round-3 re-add. compromiseUpdates is last-wins by
// round, not accumulated — unlike the add/remove fields (independent facts
// about a single term), a compromise reflects the human's current stance, so
// a later round's statement replaces an earlier, possibly-conflicting one
// instead of both surviving side by side; a round with no compromiseUpdates
// leaves the prior round's stance untouched rather than wiping it. A round
// whose delta JSON fails to parse is skipped with a warning rather than
// aborting the whole merge — one corrupt row must not silently break every
// future negotiation for this user.
export async function mergeDeltas(userId: string): Promise<FeedbackDelta> {
  const rounds = await prisma.feedbackRound.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  const dealbreakerActionByTerm = new Map<string, "add" | "remove">();
  const preferenceActionByTerm = new Map<string, "add" | "remove">();
  let compromiseUpdates: string[] = [];

  for (const round of rounds) {
    let delta: FeedbackDelta;
    try {
      delta = FeedbackDeltaSchema.parse(JSON.parse(round.delta));
    } catch (error) {
      console.warn(`delta.service: skipping malformed FeedbackRound ${round.id} delta`, error);
      continue;
    }
    for (const item of delta.addedDealbreakers) dealbreakerActionByTerm.set(item, "add");
    for (const item of delta.removedDealbreakers) dealbreakerActionByTerm.set(item, "remove");
    for (const item of delta.addedPreferences) preferenceActionByTerm.set(item, "add");
    for (const item of delta.removedPreferences) preferenceActionByTerm.set(item, "remove");
    if (delta.compromiseUpdates.length > 0) compromiseUpdates = delta.compromiseUpdates;
  }

  const addedDealbreakers: string[] = [];
  const removedDealbreakers: string[] = [];
  for (const [term, action] of dealbreakerActionByTerm) {
    (action === "add" ? addedDealbreakers : removedDealbreakers).push(term);
  }

  const addedPreferences: string[] = [];
  const removedPreferences: string[] = [];
  for (const [term, action] of preferenceActionByTerm) {
    (action === "add" ? addedPreferences : removedPreferences).push(term);
  }

  return {
    addedDealbreakers,
    removedDealbreakers,
    removedPreferences,
    addedPreferences,
    compromiseUpdates,
  };
}
