import { prisma } from "@wingman/database";
import {
  EngineSnapshotSchema,
  SnapshotLastTurnSchema,
  type EngineSnapshot,
  type SnapshotLastTurn,
} from "@wingman/shared";
import type { InterviewMode } from "../agents/interview/interview.config";
import { SESSION_TTL_MS } from "./barney.sessionRegistry";

// The durable side of the Barney session registry (#545). The registry keeps
// live InterviewEngine instances in a Map; this service keeps a JSON snapshot
// of each engine-mode session in the database, written after every turn and
// deleted on completion, so an api restart rehydrates a mid-interview session
// instead of discarding every answer given so far. Agent-mode sessions
// (pitch/debrief) are deliberately not covered — their state lives inside an
// Agent SDK subprocess, and both flows are short and cheap to restart.

// Everything needed to rebuild a session on a registry miss. lastTurn is the
// rebuilt session's turnId-replay dedup seed — see SnapshotLastTurnSchema.
export interface StoredInterviewSnapshot {
  userId: string;
  mode: InterviewMode;
  state: EngineSnapshot;
  lastTurn?: SnapshotLastTurn;
}

/**
 * Upserts the snapshot for one session. Best-effort by design: the turn it
 * trails has already succeeded, so a snapshot failure must degrade to exactly
 * the pre-#545 behaviour (an api restart loses the session) rather than fail
 * the user's answer.
 */
export async function saveInterviewSnapshot(
  sessionId: string,
  userId: string,
  mode: InterviewMode,
  state: EngineSnapshot,
  lastTurn: SnapshotLastTurn | null
): Promise<void> {
  try {
    const json = JSON.stringify(state);
    const lastTurnJson = lastTurn ? JSON.stringify(lastTurn) : null;
    await prisma.interviewSessionSnapshot.upsert({
      where: { id: sessionId },
      create: { id: sessionId, userId, mode, state: json, lastTurn: lastTurnJson },
      update: { state: json, lastTurn: lastTurnJson },
    });
  } catch (err) {
    console.error(`interview snapshot save failed for session ${sessionId}:`, err);
  }
}

/**
 * Loads a session's snapshot for rehydration, or null when there is nothing
 * worth rehydrating. Null covers, deliberately without distinguishing them for
 * the caller: no row, a row idle past the session TTL (the durable twin of
 * sweepExpired — a restart must not resurrect a session eviction would have
 * killed), a mode or state this build can't parse (a snapshot can outlive the
 * deploy that wrote it), and a snapshot whose interview already finished
 * (finalize persisted the profile; resuming would re-run a done interview).
 * Every dead row is deleted on sight so the table stays a working set, not a
 * history.
 */
export async function loadInterviewSnapshot(
  sessionId: string,
  now: number
): Promise<StoredInterviewSnapshot | null> {
  let row;
  try {
    row = await prisma.interviewSessionSnapshot.findUnique({ where: { id: sessionId } });
  } catch (err) {
    // A DB read failure degrades to the pre-#545 behaviour — "session not
    // found" — rather than turning a recovery path into a new 500.
    console.error(`interview snapshot load failed for session ${sessionId}:`, err);
    return null;
  }
  if (!row) return null;

  const expired = now - row.updatedAt.getTime() > SESSION_TTL_MS;
  if (expired || (row.mode !== "interview_self" && row.mode !== "interview_wants")) {
    await deleteInterviewSnapshot(sessionId);
    return null;
  }

  let state: EngineSnapshot;
  try {
    state = EngineSnapshotSchema.parse(JSON.parse(row.state));
  } catch {
    await deleteInterviewSnapshot(sessionId);
    return null;
  }
  if (state.done) {
    await deleteInterviewSnapshot(sessionId);
    return null;
  }

  // Parsed leniently, unlike `state`: a lastTurn this build can't read only
  // costs the replay dedup for one retried turn, which is no reason to throw
  // away a rehydratable interview.
  let lastTurn: SnapshotLastTurn | undefined;
  if (row.lastTurn) {
    try {
      lastTurn = SnapshotLastTurnSchema.parse(JSON.parse(row.lastTurn));
    } catch {
      lastTurn = undefined;
    }
  }

  return { userId: row.userId, mode: row.mode, state, lastTurn };
}

/** Removes a session's snapshot; a completed interview must never rehydrate. */
export async function deleteInterviewSnapshot(sessionId: string): Promise<void> {
  try {
    await prisma.interviewSessionSnapshot.deleteMany({ where: { id: sessionId } });
  } catch (err) {
    console.error(`interview snapshot delete failed for session ${sessionId}:`, err);
  }
}
