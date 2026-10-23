import { agentInstances, engineInstances, warmInstances, makeMatch } from "./barney.test-support";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";
import {
  changeLanguage,
  createSession,
  sendMessage,
  SessionNotFoundError,
  __resetSessions,
} from "./barney.service";
import { getMatchById } from "./match.service";
import { recordEvent } from "./audit.service";
import { prisma } from "@wingman/database";

const RESTATED = {
  reply: "How old are you?",
  phaseComplete: false,
  question: "How old are you?",
};

beforeEach(() => {
  vi.clearAllMocks();
  agentInstances.length = 0;
  engineInstances.length = 0;
  warmInstances.length = 0;
  __resetSessions();
  vi.mocked(getMatchById).mockResolvedValue(makeMatch() as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-1", gender: "male" } as never);
});

describe("changeLanguage — the mid-interview language toggle", () => {
  it("switches the engine and returns the pending question restated", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    engineInstances[0].restated = RESTATED;

    const result = await changeLanguage({ sessionId, language: "en" });

    expect(engineInstances[0].setLanguage).toHaveBeenCalledWith("en");
    expect(engineInstances[0].restatePending).toHaveBeenCalledOnce();
    expect(result).toEqual({ turn: RESTATED });
  });

  it("records the switch as an audit event carrying no text", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_wants" });

    await changeLanguage({ sessionId, language: "en" });

    expect(recordEvent).toHaveBeenCalledWith(
      "INTERVIEW_LANGUAGE_CHANGED",
      { mode: "interview_wants", language: "en" },
      { userId: "user-1" }
    );
  });

  it("snapshots the engine so a restart keeps the new language", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });

    await changeLanguage({ sessionId, language: "en" });

    expect(engineInstances[0].snapshot).toHaveBeenCalled();
    expect(prisma.interviewSessionSnapshot.upsert).toHaveBeenCalled();
  });

  it("does nothing when the language is already the session's", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "interview_self",
      language: "en",
    });
    engineInstances[0].restated = RESTATED;

    const result = await changeLanguage({ sessionId, language: "en" });

    expect(result).toEqual({ turn: null });
    expect(engineInstances[0].restatePending).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("restates nothing while a turn is still in flight, but keeps the switch", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    engineInstances[0].restated = RESTATED;
    let finishTurn: () => void = () => undefined;
    engineInstances[0].handleMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTurn = () => resolve({ reply: "next", phaseComplete: false });
        })
    );
    const turn = sendMessage({ sessionId, message: "30", turnId: "t-1" });
    // Let sendMessage reach the engine and register the pending turn.
    await Promise.resolve();

    const result = await changeLanguage({ sessionId, language: "en" });

    expect(result).toEqual({ turn: null });
    expect(engineInstances[0].setLanguage).toHaveBeenCalledWith("en");
    finishTurn();
    await turn;
  });

  it("returns no turn for a pitch session, which has no language choice", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "pitch",
      matchId: "match-1",
    });

    const result = await changeLanguage({ sessionId, language: "en" });

    expect(result).toEqual({ turn: null });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("throws SessionNotFoundError for an unknown session", async () => {
    await expect(
      changeLanguage({ sessionId: "no-such-session", language: "en" })
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("rejects a language outside the supported set", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });

    await expect(changeLanguage({ sessionId, language: "fr" })).rejects.toBeInstanceOf(ZodError);
  });
});
