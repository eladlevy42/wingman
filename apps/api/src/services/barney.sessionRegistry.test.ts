import {
  agentInstances,
  engineInstances,
  warmInstances,
  makeMatch,
  PARTNER_PROFILE,
} from "./barney.test-support";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSession,
  sendMessage,
  SessionNotFoundError,
  __resetSessions,
} from "./barney.service";
import { getMatchById } from "./match.service";
import { prisma } from "@wingman/database";

beforeEach(() => {
  vi.clearAllMocks();
  agentInstances.length = 0;
  engineInstances.length = 0;
  warmInstances.length = 0;
  __resetSessions();
  vi.mocked(getMatchById).mockResolvedValue(makeMatch() as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: "user-2",
    name: "Jordan",
    profile: { structuredData: JSON.stringify(PARTNER_PROFILE) },
  } as never);
});

describe("session eviction", () => {
  // Default TTL is 120 minutes (#255; no BARNEY_SESSION_TTL_MINUTES set in tests).
  const TTL_MS = 120 * 60_000;
  // Debrief sessions require the match's dateTime (makeMatch's default:
  // 2026-06-07T20:00:00Z) to already be in the past, so the fake clock starts
  // after it rather than at epoch 0.
  const BASE_TIME = new Date("2026-06-08T00:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts a session left idle past the TTL, so its next request is a 404", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });

    vi.setSystemTime(BASE_TIME + TTL_MS + 1);

    await expect(sendMessage({ sessionId, message: "still there?" })).rejects.toThrow(
      SessionNotFoundError
    );
  });

  it("keeps a session alive while it keeps sending within the TTL", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });
    agentInstances[0].reply = "still here";

    // Just before the TTL — a turn here refreshes the idle timer.
    vi.setSystemTime(BASE_TIME + TTL_MS - 1);
    await expect(sendMessage({ sessionId, message: "a" })).resolves.toMatchObject({
      reply: "still here",
    });

    // Past the TTL measured from init, but within it from the last turn.
    vi.setSystemTime(BASE_TIME + TTL_MS - 1 + (TTL_MS - 1));
    await expect(sendMessage({ sessionId, message: "b" })).resolves.toMatchObject({
      reply: "still here",
    });
  });

  it("sweeps a stale session when an unrelated registry call runs", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });

    vi.setSystemTime(BASE_TIME + TTL_MS + 1);
    // A fresh session triggers the sweep that drops the expired one.
    await createSession({ userId: "user-2", mode: "debrief", matchId: "match-1" });

    await expect(sendMessage({ sessionId, message: "?" })).rejects.toThrow(SessionNotFoundError);
  });

  it("closes the warm runner when an idle engine session is swept", async () => {
    await createSession({ userId: "user-1", mode: "interview_self" });
    expect(warmInstances).toHaveLength(1);

    vi.setSystemTime(BASE_TIME + TTL_MS + 1);
    // Any registry access sweeps the expired engine session, which must free its
    // warm soft-turn subprocess before dropping it (#246).
    await createSession({ userId: "user-2", mode: "interview_self" });

    expect(warmInstances[0].close).toHaveBeenCalledTimes(1);
  });
});
