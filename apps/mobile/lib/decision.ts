import {
  DecideMatchResponseSchema,
  DecideMatchSchema,
  type DecideMatchResponse,
} from "@wingman/shared";
import { apiRequest } from "./api";

/** The Yeah/Nah a user gives on the pitch's decision screen. */
export type Decision = "yeah" | "nah";

/**
 * Records the user's decision on their current match (#464).
 *
 * Unlike the reveal, this one throws. The reveal is a decoration the pitch can
 * do without; a decision the user believes they made and the server never
 * recorded is the opposite — silence here would leave them waiting on a match
 * that is not waiting on them, until the decision window expires and auto-Nahs
 * it. The screen turns the failure into a retry.
 *
 * The request is parsed with the shared schema before it is sent, the same way
 * lib/photo does. matchId comes from a state response that may legitimately
 * omit it (nobody is matched), and posting `{"matchId": undefined}` would come
 * back as a 400 full of Zod issues rather than something the screen can act on.
 */
export async function submitDecision(
  matchId: string | undefined,
  userId: string,
  decision: Decision
): Promise<DecideMatchResponse> {
  const body = DecideMatchSchema.parse({ matchId, userId, decision });
  return apiRequest("/api/match/decide", {
    method: "POST",
    body,
    schema: DecideMatchResponseSchema,
    fallbackErrorMessage: "Could not record your decision. Please try again.",
  });
}
