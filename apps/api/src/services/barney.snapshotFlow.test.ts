import { engineInstances, warmInstances } from "./barney.test-support";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EngineSnapshot } from "@wingman/shared";
import {
  createSession,
  sendMessage,
  SessionNotFoundError,
  __resetSessions,
} from "./barney.service";
import { prisma } from "@wingman/database";

// The wiring of #545 through the message service: every engine turn leaves a
// durable snapshot behind, completion cleans it up, and a registry miss
// rehydrates from it instead of 404ing. The engine itself is the fake from
// barney.test-support — its snapshot() is a canned marker — because what is
// under test here is when the service stores/loads, not what the engine packs.

const STORED_STATE: EngineSnapshot = {
  language: "he",
  started: true,
  done: false,
  currentIndex: 3,
  probesUsed: 0,
  history: [0, 1, 2, 3],
  awaitingAddendum: false,
  wrapupOffered: false,
  collected: { age: 28 },
  transcript: ["Barney: [redacted]", "User: 28"],
  factAckIndex: 1,
};

const mockFind = vi.mocked(prisma.interviewSessionSnapshot.findUnique);
const mockUpsert = vi.mocked(prisma.interviewSessionSnapshot.upsert);
const mockDelete = vi.mocked(prisma.interviewSessionSnapshot.deleteMany);

beforeEach(() => {
  vi.clearAllMocks();
  engineInstances.length = 0;
  warmInstances.length = 0;
  __resetSessions();
  mockFind.mockResolvedValue(null as never);
  mockUpsert.mockResolvedValue(undefined as never);
  mockDelete.mockResolvedValue({ count: 0 } as never);
});

describe("engine turns leave a durable snapshot", () => {
  it("upserts the engine's snapshot after a mid-interview turn", async () => {
    const { sessionId } = await createSession({ userId: "u-1", mode: "interview_self" });

    await sendMessage({ sessionId, message: "28" });

    expect(engineInstances[0].snapshot).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sessionId },
        create: expect.objectContaining({
          id: sessionId,
          userId: "u-1",
          mode: "interview_self",
        }),
      })
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes the snapshot instead when the phase completes", async () => {
    const { sessionId } = await createSession({ userId: "u-1", mode: "interview_self" });
    engineInstances[0].result = { reply: "done!", phaseComplete: true };

    await sendMessage({ sessionId, message: "that's everything" });

    expect(mockDelete).toHaveBeenCalledWith({ where: { id: sessionId } });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("a registry miss rehydrates from the snapshot", () => {
  const LOST_SESSION = "99999999-8888-4777-a666-555555555555";

  function storeSnapshot(lastTurn: { turnId: string; result: object } | null = null) {
    mockFind.mockResolvedValue({
      id: LOST_SESSION,
      userId: "u-lost",
      mode: "interview_wants",
      state: JSON.stringify(STORED_STATE),
      lastTurn: lastTurn ? JSON.stringify(lastTurn) : null,
      updatedAt: new Date(),
    } as never);
  }

  it("rebuilds the engine session and answers the turn", async () => {
    storeSnapshot();

    const result = await sendMessage({ sessionId: LOST_SESSION, message: "next answer" });

    // A new engine was built for the snapshot's user, restored to the stored
    // state, and the turn ran on it as if the restart never happened.
    expect(result.reply).toBe("engine reply");
    expect(engineInstances).toHaveLength(1);
    expect(engineInstances[0].userId).toBe("u-lost");
    expect(engineInstances[0].restore).toHaveBeenCalledWith(STORED_STATE);
    // The rebuilt session got its own warm soft-turn, prewarmed like a fresh one.
    expect(warmInstances).toHaveLength(1);
    expect(warmInstances[0].prewarm).toHaveBeenCalled();
  });

  it("registers the rebuilt session under its original id — the next turn is a plain hit", async () => {
    storeSnapshot();
    await sendMessage({ sessionId: LOST_SESSION, message: "first after restart" });
    mockFind.mockClear();

    await sendMessage({ sessionId: LOST_SESSION, message: "second after restart" });

    expect(mockFind).not.toHaveBeenCalled();
    expect(engineInstances).toHaveLength(1);
  });

  it("still 404s when there is no snapshot to rehydrate", async () => {
    await expect(sendMessage({ sessionId: LOST_SESSION, message: "hello?" })).rejects.toThrow(
      SessionNotFoundError
    );
  });

  // The restart-replay window: the old process answered turn t-9 and died
  // before the client heard; the client's stream-drop fallback retries t-9
  // against the new process. The snapshot carries the answered turn, so the
  // retry gets the cached result — running it on the restored engine would
  // consume the retried text as the answer to the NEXT question.
  it("answers a replayed turnId from the snapshot instead of re-running the engine", async () => {
    storeSnapshot({ turnId: "t-9", result: { reply: "the cached answer", phaseComplete: false } });

    const result = await sendMessage({
      sessionId: LOST_SESSION,
      message: "the same answer, retried",
      turnId: "t-9",
    });

    expect(result).toEqual({ reply: "the cached answer", phaseComplete: false });
    expect(engineInstances[0].handleMessage).not.toHaveBeenCalled();
  });

  // The stream endpoint and its stream-drop fallback can both miss the
  // registry for the same lost id at once — the loser of that race must adopt
  // the winner's session, not overwrite it with a second engine (and leak the
  // winner's warm subprocess).
  it("rehydrates once when two requests race for the same lost session", async () => {
    storeSnapshot();

    await Promise.all([
      sendMessage({ sessionId: LOST_SESSION, message: "same turn", turnId: "t-1" }),
      sendMessage({ sessionId: LOST_SESSION, message: "same turn", turnId: "t-1" }),
    ]);

    expect(engineInstances).toHaveLength(1);
    expect(warmInstances).toHaveLength(1);
    expect(engineInstances[0].handleMessage).toHaveBeenCalledTimes(1);
  });
});
