import { BarneyLanguageInputSchema } from "@wingman/shared";
import type { BarneyLanguageResponse } from "@wingman/shared";
import { sessions, sweepExpired, SessionNotFoundError } from "./barney.sessionRegistry";
import { rehydrateEngineSession } from "./barney.session.service";
import { saveInterviewSnapshot } from "./interviewSnapshot.service";
import { recordEvent } from "./audit.service";

/**
 * The mid-interview language toggle (ADR-0037). Switches the session's engine
 * and hands back the question the user is still owed, restated in the new
 * language, so the client can replace the one on screen instead of leaving it
 * in the language the user just switched away from.
 *
 * Every turn already carries the language, so this is not what makes the next
 * reply switch — it only covers the gap between the tap and that reply.
 */
export async function changeLanguage(input: unknown): Promise<BarneyLanguageResponse> {
  const { sessionId, language } = BarneyLanguageInputSchema.parse(input);
  const now = Date.now();
  sweepExpired(now);

  const session = sessions.get(sessionId) ?? (await rehydrateEngineSession(sessionId, now));
  if (!session) throw new SessionNotFoundError("Session not found");
  session.lastAccessAt = now;

  // Pitch and debrief are not part of the interview language choice.
  if (session.kind !== "engine") return { turn: null };
  if (session.engine.getLanguage() === language) return { turn: null };

  session.engine.setLanguage(language);
  await recordEvent(
    "INTERVIEW_LANGUAGE_CHANGED",
    { mode: session.mode, language },
    { userId: session.userId }
  );

  // A turn still running was rendered in the old language and will land on
  // top of anything restated now; the language still applies from the reply
  // after it. The client disables the toggle mid-turn, so this is a backstop.
  if (session.pendingTurns.size > 0) return { turn: null };

  const turn = session.engine.restatePending();
  // The language is engine state, so a restart must not revert it. The last
  // turn is carried over unchanged to keep the turnId-replay dedup intact.
  await saveInterviewSnapshot(
    sessionId,
    session.userId,
    session.mode,
    session.engine.snapshot(),
    session.lastTurn ?? null
  );
  return { turn };
}
