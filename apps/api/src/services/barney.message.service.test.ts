import {
  agentInstances,
  engineInstances,
  warmInstances,
  makeMatch,
  PARTNER_PROFILE,
} from "./barney.test-support";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";
import type { BarneyStreamEvent } from "@wingman/shared";
import {
  createSession,
  sendMessage,
  streamMessage,
  SessionNotFoundError,
  __resetSessions,
} from "./barney.service";
import { triggerFirstMatchCycle } from "./orchestration.service";
import { getMatchById } from "./match.service";
import { prisma } from "@wingman/database";
import { markDebriefed } from "./followup.service";

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

describe("sendMessage — debrief completion", () => {
  it("advances the FollowUp to DEBRIEFED when saveFeedback fires", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });
    agentInstances[0].toolCalls = [{ name: "saveFeedback" }];

    const result = await sendMessage({ sessionId, message: "That covers it" });

    expect(result.phaseComplete).toBe(true);
    expect(markDebriefed).toHaveBeenCalledWith("user-1", "match-1");
  });

  it("does not advance the FollowUp while the debrief is still in progress", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });

    await sendMessage({ sessionId, message: "It was fine" });

    expect(markDebriefed).not.toHaveBeenCalled();
  });
});

describe("sendMessage — engine modes", () => {
  it("delegates to the engine and returns its turn result verbatim", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    engineInstances[0].result = { reply: "How old are you?", phaseComplete: false };

    const result = await sendMessage({ sessionId, message: "hi" });

    expect(result).toEqual({ reply: "How old are you?", phaseComplete: false });
    expect(engineInstances[0].handleMessage).toHaveBeenCalledWith("hi");
  });

  it("passes through phaseComplete: true when the engine signals completion", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    engineInstances[0].result = { reply: "locked in", phaseComplete: true };

    const result = await sendMessage({ sessionId, message: "that's me" });

    expect(result.phaseComplete).toBe(true);
  });
});

// A dropped stream's fallback retry (BarneyPhase1.tsx's streamingTurn) resends
// the same user answer with the same turnId. Without dedup this would call
// InterviewEngine.handleMessage twice for one answer, silently double-
// advancing the tree / corrupting collected profile data.
describe("sendMessage — turnId dedup (retry after a dropped stream)", () => {
  it("returns the cached result instead of re-invoking the engine for a repeated turnId", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    engineInstances[0].result = { reply: "How old are you?", phaseComplete: false };

    const first = await sendMessage({ sessionId, message: "30", turnId: "turn-1" });
    const retry = await sendMessage({ sessionId, message: "30", turnId: "turn-1" });

    expect(retry).toEqual(first);
    expect(engineInstances[0].handleMessage).toHaveBeenCalledTimes(1);
  });

  it("still processes a new turn once its turnId differs", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    engineInstances[0].result = { reply: "How old are you?", phaseComplete: false };
    await sendMessage({ sessionId, message: "30", turnId: "turn-1" });

    engineInstances[0].result = { reply: "Where do you live?", phaseComplete: false };
    const second = await sendMessage({ sessionId, message: "Tel Aviv", turnId: "turn-2" });

    expect(second).toEqual({ reply: "Where do you live?", phaseComplete: false });
    expect(engineInstances[0].handleMessage).toHaveBeenCalledTimes(2);
  });

  it("processes every call when no turnId is supplied (back-compat, no dedup)", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    engineInstances[0].result = { reply: "How old are you?", phaseComplete: false };

    await sendMessage({ sessionId, message: "30" });
    await sendMessage({ sessionId, message: "30" });

    expect(engineInstances[0].handleMessage).toHaveBeenCalledTimes(2);
  });

  it("dedupes an agent-mode turn (pitch/debrief) the same way", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });
    agentInstances[0].reply = "Nice to meet you!";

    const first = await sendMessage({ sessionId, message: "Hi Barney", turnId: "turn-1" });
    const retry = await sendMessage({ sessionId, message: "Hi Barney", turnId: "turn-1" });

    expect(retry).toEqual(first);
    expect(agentInstances[0].sendMessage).toHaveBeenCalledTimes(1);
  });

  // The stream-drop fallback fires while the original turn is usually still
  // running — session.lastTurn is only written on completion, so the dedup
  // above (which relies on lastTurn) can't catch this case. A same-turnId call
  // that arrives before the first one settles must await the same turn
  // instead of invoking the engine/agent a second time.
  it("awaits the in-flight turn for a concurrent repeat call on an engine session", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    let resolveTurn!: (result: { reply: string; phaseComplete: boolean }) => void;
    const inFlight = new Promise<{ reply: string; phaseComplete: boolean }>((resolve) => {
      resolveTurn = resolve;
    });
    engineInstances[0].handleMessage.mockImplementation(() => inFlight);

    const first = sendMessage({ sessionId, message: "30", turnId: "turn-1" });
    const second = sendMessage({ sessionId, message: "30", turnId: "turn-1" });
    resolveTurn({ reply: "How old are you?", phaseComplete: false });

    await expect(second).resolves.toEqual(await first);
    expect(engineInstances[0].handleMessage).toHaveBeenCalledTimes(1);
  });

  // Same race on an agent session (pitch/debrief): before this fix, the second
  // call would hit BarneyAgent's own busy guard and reject instead of
  // returning the original turn's reply.
  it("awaits the in-flight turn for a concurrent repeat call on an agent session, without a busy throw", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });
    let resolveTurn!: (reply: string) => void;
    const inFlight = new Promise<string>((resolve) => {
      resolveTurn = resolve;
    });
    agentInstances[0].sendMessage.mockImplementation(() => inFlight);

    const first = sendMessage({ sessionId, message: "Hi Barney", turnId: "turn-1" });
    const second = sendMessage({ sessionId, message: "Hi Barney", turnId: "turn-1" });
    resolveTurn("Nice to meet you!");

    await expect(second).resolves.toEqual(await first);
    expect(agentInstances[0].sendMessage).toHaveBeenCalledTimes(1);
  });

  // pendingTurns' cleanup uses turnPromise.finally(...), which returns a
  // *different* promise than turnPromise itself. If a rejected turn's cleanup
  // promise were left unhandled, Node would raise an unhandledRejection for
  // every failed turn that carries a turnId (i.e. essentially all real
  // traffic) on top of the rejection sendMessage's own caller already sees.
  it("does not raise an unhandled rejection when an in-flight turn fails", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
      engineInstances[0].handleMessage.mockRejectedValueOnce(new Error("engine blew up"));

      await expect(sendMessage({ sessionId, message: "30", turnId: "turn-1" })).rejects.toThrow(
        "engine blew up"
      );
      // Let the finally()-derived cleanup promise's microtask settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();

      // The failed turn must not leave a stale pendingTurns entry behind —
      // a retry with the same turnId should invoke the engine again rather
      // than hanging forever on a promise that already settled.
      engineInstances[0].result = { reply: "How old are you?", phaseComplete: false };
      const retry = await sendMessage({ sessionId, message: "30", turnId: "turn-1" });

      expect(retry).toEqual({ reply: "How old are you?", phaseComplete: false });
      expect(engineInstances[0].handleMessage).toHaveBeenCalledTimes(2);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("interview_wants routing and Phase 2 completion trigger", () => {
  it("routes interview_wants to the InterviewEngine, not the agent", async () => {
    await createSession({ userId: "user-1", mode: "interview_wants" });

    expect(engineInstances).toHaveLength(1);
    expect(engineInstances[0].userId).toBe("user-1");
    expect(agentInstances).toHaveLength(0);
  });

  it("fires the first match cycle when a wants session reports completion", async () => {
    const { sessionId } = await createSession({ userId: "user-7", mode: "interview_wants" });
    engineInstances[0].result = { reply: "locked in", phaseComplete: true };

    const result = await sendMessage({ sessionId, message: "that's everything" });

    expect(result.phaseComplete).toBe(true);
    expect(triggerFirstMatchCycle).toHaveBeenCalledWith("user-7");
  });

  it("does NOT fire matching while the wants interview is still in progress", async () => {
    const { sessionId } = await createSession({ userId: "user-7", mode: "interview_wants" });
    engineInstances[0].result = { reply: "and the oldest?", phaseComplete: false };

    await sendMessage({ sessionId, message: "25" });

    expect(triggerFirstMatchCycle).not.toHaveBeenCalled();
  });

  it("does NOT fire matching when Phase 1 (interview_self) completes", async () => {
    const { sessionId } = await createSession({ userId: "user-7", mode: "interview_self" });
    engineInstances[0].result = { reply: "locked in", phaseComplete: true };

    const result = await sendMessage({ sessionId, message: "that's me" });

    expect(result.phaseComplete).toBe(true);
    expect(triggerFirstMatchCycle).not.toHaveBeenCalled();
  });
});

// These use "debrief" — a non-engine, non-pitch BarneyAgent mode — because
// they exercise generic agent-session behavior (message routing, eviction)
// that has nothing to do with pitch's matchId/rationale requirements. Pitch
// mode's own creation behavior is covered separately in
// barney.session.service.test.ts.
describe("sendMessage — agent modes", () => {
  it("returns the agent's reply for a known session", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });
    agentInstances[0].reply = "Nice to meet you!";

    const result = await sendMessage({ sessionId, message: "Hi Barney" });

    expect(result).toEqual({ reply: "Nice to meet you!", phaseComplete: false });
    expect(agentInstances[0].sendMessage).toHaveBeenCalledWith("Hi Barney");
  });

  it("reports phaseComplete: true on the turn saveProfile fires", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });
    agentInstances[0].reply = "All saved!";
    agentInstances[0].toolCalls = [{ name: "saveProfile" }];

    const result = await sendMessage({ sessionId, message: "That's everything" });

    expect(result.phaseComplete).toBe(true);
  });

  it("does not let one turn's listener leak into the next", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });

    agentInstances[0].toolCalls = [{ name: "saveProfile" }];
    const first = await sendMessage({ sessionId, message: "save it" });
    expect(first.phaseComplete).toBe(true);

    agentInstances[0].toolCalls = [];
    const second = await sendMessage({ sessionId, message: "follow-up" });
    expect(second.phaseComplete).toBe(false);
  });

  it("throws SessionNotFoundError for an unknown sessionId", async () => {
    await expect(sendMessage({ sessionId: "does-not-exist", message: "hello" })).rejects.toThrow(
      SessionNotFoundError
    );
  });

  it("throws a ZodError on an empty message", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "debrief",
      matchId: "match-1",
    });

    await expect(sendMessage({ sessionId, message: "" })).rejects.toThrow(ZodError);
  });
});

describe("streamMessage", () => {
  // Groups the streamed deltas by their preceding bubble_start, so the test can
  // assert each bubble reassembles to the original text.
  function collectBubbles(events: BarneyStreamEvent[]): Record<string, string> {
    const bubbles: Record<string, string> = {};
    let current = "";
    for (const event of events) {
      if (event.type === "bubble_start") {
        current = event.bubble;
        bubbles[current] = "";
      } else if (event.type === "delta") {
        bubbles[current] += event.text;
      }
    }
    return bubbles;
  }

  it("streams an engine turn as acknowledgement + question bubbles, then a done event", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    (engineInstances.at(-1) as { result: unknown }).result = {
      reply: "Got it. Which city do you live in?",
      phaseComplete: false,
      acknowledgement: "Got it.",
      question: "Which city do you live in?",
      section: { title: "The basics", index: 1, total: 5 },
      progress: { answered: 1, total: 16 },
      input: { kind: "text" },
    };

    const events: BarneyStreamEvent[] = [];
    for await (const event of streamMessage({ sessionId, message: "30" })) {
      events.push(event);
    }

    const starts = events.filter((e) => e.type === "bubble_start");
    expect(starts.map((e) => (e.type === "bubble_start" ? e.bubble : ""))).toEqual([
      "acknowledgement",
      "question",
    ]);

    const bubbles = collectBubbles(events);
    expect(bubbles.acknowledgement).toBe("Got it.");
    expect(bubbles.question).toBe("Which city do you live in?");

    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      phaseComplete: false,
      section: { title: "The basics", index: 1, total: 5 },
      progress: { answered: 1, total: 16 },
      input: { kind: "text" },
    });
  });

  it("streams a single bubble for an agent turn that only has a reply", async () => {
    const { sessionId } = await createSession({
      userId: "user-1",
      mode: "pitch",
      matchId: "match-1",
    });
    agentInstances.at(-1)!.reply = "She loves hiking too.";

    const events: BarneyStreamEvent[] = [];
    for await (const event of streamMessage({ sessionId, message: "does she hike?" })) {
      events.push(event);
    }

    const starts = events.filter((e) => e.type === "bubble_start");
    expect(starts.map((e) => (e.type === "bubble_start" ? e.bubble : ""))).toEqual(["question"]);
    expect(collectBubbles(events).question).toBe("She loves hiking too.");
  });

  it("propagates a session-not-found error before yielding any event", async () => {
    const generator = streamMessage({ sessionId: "does-not-exist", message: "hi" });
    await expect(generator.next()).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

// ADR-0037 — the client sends the interview language on every turn, so the flag
// toggle takes effect from the next reply and a resumed conversation re-asserts
// the saved choice rather than reverting to the default.
describe("sendMessage — interview language", () => {
  it("applies a per-turn language switch to the engine", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    expect(engineInstances[0].language).toBeUndefined();

    await sendMessage({ sessionId, message: "start", language: "en" });

    expect(engineInstances[0].setLanguage).toHaveBeenCalledWith("en");
    expect(engineInstances[0].language).toBe("en");
  });

  it("leaves the engine's language alone when the turn carries none", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });

    await sendMessage({ sessionId, message: "start" });

    expect(engineInstances[0].setLanguage).not.toHaveBeenCalled();
  });
});
