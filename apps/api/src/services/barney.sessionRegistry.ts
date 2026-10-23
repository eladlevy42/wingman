import type { BarneyMode, BarneyMessageResponse } from "@wingman/shared";
import { BarneyAgent } from "../agents/barney.agent";
import { InterviewEngine } from "../agents/interview/interview.engine";
import type { InterviewMode } from "../agents/interview/interview.config";

// How long a session may sit idle before it is evicted. The BarneyAgent holds
// the whole conversation in process memory (see docs/adr/0003), so without a
// bound a long-running process accumulates sessions forever. Eviction is lazy:
// every registry access first sweeps expired entries, which is enough to cap
// memory without a background timer (which would dangle the event loop and
// complicate process shutdown). A request for an evicted sessionId returns 404
// like any unknown one — except that engine sessions now have a durable twin
// (#545): interviewSnapshot.service keeps a per-turn snapshot in the DB, and a
// registry miss rehydrates from it before 404ing, so neither eviction nor an
// api restart discards a mid-interview `collected` bag anymore. The TTL below
// bounds both stores: a snapshot idle past it is dropped on load exactly as an
// in-memory session is swept. Raised from 30 to 120 minutes: a real interview
// takes minutes, not hours, so this measurably reduces how often idle
// abandonment (not just a slow typer) ends an interview mid-flight.
const DEFAULT_TTL_MINUTES = 120;
// Exported for the durable snapshots (#545): a stored snapshot idle past the
// same TTL is treated exactly like an evicted in-memory session, so restarting
// the api never extends a session's life beyond what staying up would have.
export const SESSION_TTL_MS = resolveTtlMs();

function resolveTtlMs(): number {
  const raw = process.env.BARNEY_SESSION_TTL_MINUTES;
  const minutes = raw === undefined ? DEFAULT_TTL_MINUTES : Number(raw);
  // Guard against a malformed env value silently disabling eviction.
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_TTL_MINUTES * 60_000;
  return minutes * 60_000;
}

// A session runs on exactly one driver, fixed at creation by its mode. The
// engine path reports phaseComplete directly; the agent path infers it from a
// completion tool firing.
export type Session = {
  lastAccessAt: number;
  // The most recently completed turn, keyed by the client-supplied turnId. The
  // streamed /message/stream endpoint and its /message fallback can both fire
  // for the same user turn when a connection drops mid-stream (see
  // streamMessage in barney.message.service.ts) — replaying that turnId here
  // returns the already-computed result instead of re-invoking the stateful
  // engine/agent a second time, which would silently double-advance the
  // interview or the agent's conversation history.
  lastTurn?: { turnId: string; result: BarneyMessageResponse };
  // Turns currently running, keyed by the client-supplied turnId. The stream-
  // drop fallback (see streamMessage) can fire while the original turn is
  // still in flight — session.lastTurn is only written after completion, so
  // that guard alone misses this case. sendMessage consults this map first:
  // a hit means "await the turn already running" instead of invoking the
  // stateful engine/agent a second time for the same user answer.
  pendingTurns: Map<string, Promise<BarneyMessageResponse>>;
} &
  // Engine sessions carry their mode + userId so completion can fire the right
  // side-effect: only interview_wants kicks off the first matching cycle.
  // closeWarm tears down the session's warm soft-turn subprocess (see #246);
  // it is called on completion and on TTL eviction, and is idempotent.
  // Agent sessions carry userId/matchId too, but only debrief's completion
  // (saveFeedback) has a side-effect (markDebriefed) that needs them.
  (| {
        kind: "engine";
        engine: InterviewEngine;
        mode: InterviewMode;
        userId: string;
        closeWarm: () => void;
      }
    | { kind: "agent"; agent: BarneyAgent; mode: BarneyMode; userId: string; matchId?: string }
  );

export const sessions = new Map<string, Session>();

// Drops every session idle past the TTL. Called at the start of each registry
// access so eviction needs no timer.
export function sweepExpired(now: number): void {
  for (const [sessionId, session] of sessions) {
    if (now - session.lastAccessAt > SESSION_TTL_MS) {
      // Free the warm soft-turn subprocess before dropping an engine session.
      if (session.kind === "engine") session.closeWarm();
      sessions.delete(sessionId);
    }
  }
}

export class SessionNotFoundError extends Error {}

// Test-only hook — clears the registry so suites do not leak sessions.
export function __resetSessions(): void {
  sessions.clear();
}
