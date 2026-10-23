import { BarneyMessageInputSchema } from "@wingman/shared";
import type { BarneyMessageResponse, BarneyStreamEvent } from "@wingman/shared";
import type { ToolCallEvent } from "../agents/barney.agent";
import { triggerFirstMatchCycle } from "./orchestration.service";
import { markDebriefed } from "./followup.service";
import type { Session } from "./barney.sessionRegistry";
import { sessions, sweepExpired, SessionNotFoundError } from "./barney.sessionRegistry";
import { rehydrateEngineSession } from "./barney.session.service";
import { saveInterviewSnapshot, deleteInterviewSnapshot } from "./interviewSnapshot.service";

// The completion tool whose firing marks a phase done. Phase 1 (interview_self)
// and debrief each have exactly one. Phase 2 (interview_wants) completes via
// InterviewEngine calling persistWantedProfile() directly, not a model tool
// call (see docs/adr/0004, docs/adr/0005) — it will never join this set.
const PHASE_COMPLETION_TOOLS = new Set(["saveProfile", "saveFeedback"]);

export async function sendMessage(input: unknown): Promise<BarneyMessageResponse> {
  const { sessionId, message, turnId, language } = BarneyMessageInputSchema.parse(input);
  const now = Date.now();
  sweepExpired(now);

  // A registry miss is no longer the end of an interview (#545): engine
  // sessions snapshot to the DB after every turn, so an api restart (or a TTL
  // eviction the snapshot outlived by moments) rehydrates here instead of
  // 404ing the client into a fresh session that re-asks everything.
  const session = sessions.get(sessionId) ?? (await rehydrateEngineSession(sessionId, now));
  if (!session) throw new SessionNotFoundError("Session not found");
  // Refresh idle timer: TTL measures time since the last turn, not since init.
  session.lastAccessAt = now;

  // The client sends the interview language on every turn (ADR-0037), so the
  // flag toggle takes effect from the next reply and a resumed conversation
  // re-asserts the user's saved choice. Applied before the replay guards below
  // so a language switch never lands on a cached turn's stale wording.
  if (language && session.kind === "engine") {
    session.engine.setLanguage(language);
  }

  // Replaying the turn that was just processed (identified by the client's
  // turnId, not by message content — the same text can legitimately answer two
  // different questions in a row). This is the fallback-after-stream-drop path:
  // short-circuit instead of re-running the turn against the stateful
  // engine/agent a second time.
  if (turnId && session.lastTurn?.turnId === turnId) {
    return session.lastTurn.result;
  }

  // The fallback almost always fires while the original turn is still
  // in-flight (see the pendingTurns doc comment in barney.sessionRegistry.ts),
  // so lastTurn alone misses it — await the running turn's own promise instead
  // of starting a second execution.
  const inFlight = turnId ? session.pendingTurns.get(turnId) : undefined;
  if (inFlight) return inFlight;

  const turnPromise = runTurn(session, sessionId, message, turnId);
  if (turnId) {
    session.pendingTurns.set(turnId, turnPromise);
    void turnPromise
      .finally(() => session.pendingTurns.delete(turnId))
      .catch(() => {
        // The caller of sendMessage() already handles turnPromise's own rejection;
        // this catch exists solely to prevent the .finally()-derived promise (a
        // distinct object) from surfacing as an unhandled rejection.
      });
  }
  return turnPromise;
}

async function runTurn(
  session: Session,
  sessionId: string,
  message: string,
  turnId: string | undefined
): Promise<BarneyMessageResponse> {
  // Engine-driven modes (ADR 0004) report phaseComplete directly.
  if (session.kind === "engine") {
    const result = await session.engine.handleMessage(message);
    // The turn's durable twin (#545): a completed interview's snapshot is
    // deleted (finalize already persisted the profile — the one thing that
    // must never rehydrate is a finished interview), any other turn upserts
    // the engine's current state plus this turn's id and result, so the
    // turnId-replay dedup survives a restart too (a retried turn must get the
    // cached answer, not advance the restored engine again). Awaited so the
    // snapshot is on disk before the client hears the turn succeeded; both are
    // best-effort inside the service, so a snapshot hiccup never fails the
    // user's answer.
    if (result.phaseComplete) {
      await deleteInterviewSnapshot(sessionId);
    } else {
      await saveInterviewSnapshot(
        sessionId,
        session.userId,
        session.mode,
        session.engine.snapshot(),
        turnId ? { turnId, result } : null
      );
    }
    // The interview is over on completion — no more soft turns will run, so tear
    // down the warm subprocess now rather than waiting for TTL eviction (#246).
    if (result.phaseComplete) session.closeWarm();
    // Completing Phase 2 is the event that carries the user into matching: the
    // wants profile is now persisted and matchingState is WAITING (done inside
    // persistWantedProfile), so kick off the first matching cycle immediately
    // rather than waiting for the next orchestration tick. Phase 1 completion
    // must NOT trigger matching — the user still has the wants interview to do.
    if (session.mode === "interview_wants" && result.phaseComplete) {
      // Fire-and-forget: persistence already succeeded, so a matching failure
      // must not fail the user's final interview turn. #44 owns retry/robustness.
      void triggerFirstMatchCycle(session.userId).catch((err) => {
        console.error("triggerFirstMatchCycle failed after Phase 2 completion:", err);
      });
    }
    if (turnId) session.lastTurn = { turnId, result };
    return result;
  }

  // Agent-driven modes infer phaseComplete from a completion tool firing. The
  // Agent SDK validates tool input against its schema before invoking the
  // handler (see docs/adr/0011), so "toolCall" only ever fires on a genuine,
  // already-persisted save — there is no separate invalid-input event to
  // filter out here anymore.
  const { agent } = session;
  let phaseComplete = false;
  const onToolCall = (event: ToolCallEvent) => {
    if (PHASE_COMPLETION_TOOLS.has(event.name)) {
      phaseComplete = true;
    }
  };
  agent.on("toolCall", onToolCall);
  try {
    const reply = await agent.sendMessage(message);
    // Debrief's saveFeedback firing is this session's terminal event — advance
    // the FollowUp row so the user isn't nudged to debrief again. Fire-and-
    // forget: the feedback itself is already persisted (saveFeedback.ts), so a
    // failure here must not fail the user's closing turn. Unlike Phase 2's
    // triggerFirstMatchCycle failure (which #44 tracks for retry), this failure
    // has no tracked follow-up yet — a failed update here leaves the FollowUp
    // row stuck at DATE_PASSED and the user gets re-nudged to debrief again.
    if (session.mode === "debrief" && phaseComplete && session.matchId) {
      void markDebriefed(session.userId, session.matchId).catch((err) => {
        console.error("markDebriefed failed after saveFeedback completion:", err);
      });
    }
    const result = { reply, phaseComplete };
    if (turnId) session.lastTurn = { turnId, result };
    return result;
  } finally {
    agent.off("toolCall", onToolCall);
  }
}

// Per-word delay while streaming a computed reply, and a short beat between the
// acknowledgement bubble and the question bubble. The client paces the actual
// visual reveal (a smooth typewriter, independent of network timing), so the
// server only needs to push words fast enough to stay ahead of that reveal — it
// deliberately does NOT own the visible cadence or the inter-bubble beat anymore.
const STREAM_WORD_DELAY_MS = 10;
const STREAM_BUBBLE_GAP_MS = 60;

const streamSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Splits text into word chunks that keep their trailing whitespace, so the
// reassembled stream is identical to the original string.
function toWordChunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

// Streaming counterpart of sendMessage. Runs the exact same turn (so validation,
// phase-completion side effects, and session bookkeeping all happen once, in
// sendMessage), then yields the computed acknowledgement and question as a
// word-by-word stream. Engine turns split into two bubbles; agent turns
// (pitch/debrief) stream their single reply. The whole model turn resolves
// before the first token is yielded, so the client shows its typing indicator
// during model latency and then sees the reply stream in.
export async function* streamMessage(input: unknown): AsyncGenerator<BarneyStreamEvent> {
  const result = await sendMessage(input);

  const bubbles: { bubble: "acknowledgement" | "question"; text: string }[] = [];
  if (result.acknowledgement) {
    bubbles.push({ bubble: "acknowledgement", text: result.acknowledgement });
  }
  if (result.question) {
    bubbles.push({ bubble: "question", text: result.question });
  }
  // Agent modes (pitch/debrief) only carry `reply`; stream it as one bubble.
  if (bubbles.length === 0) {
    bubbles.push({ bubble: "question", text: result.reply });
  }

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await streamSleep(STREAM_BUBBLE_GAP_MS);
    yield { type: "bubble_start", bubble: bubbles[i].bubble };
    for (const chunk of toWordChunks(bubbles[i].text)) {
      yield { type: "delta", text: chunk };
      await streamSleep(STREAM_WORD_DELAY_MS);
    }
  }

  yield {
    type: "done",
    phaseComplete: result.phaseComplete,
    section: result.section ?? null,
    progress: result.progress,
    input: result.input,
  };
}
