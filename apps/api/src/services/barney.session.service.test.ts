import {
  agentInstances,
  engineInstances,
  warmInstances,
  createWarmSoftTurn,
  makeMatch,
  PARTNER_PROFILE,
} from "./barney.test-support";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";
import {
  createSession,
  sendMessage,
  MatchNotFoundError,
  MatchOwnershipError,
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

describe("createSession", () => {
  it("routes interview_self to the InterviewEngine, not the agent", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });

    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(engineInstances).toHaveLength(1);
    expect(engineInstances[0].userId).toBe("user-1");
    expect(agentInstances).toHaveLength(0);
  });

  it("issues a distinct sessionId per call", async () => {
    const a = await createSession({ userId: "user-1", mode: "interview_self" });
    const b = await createSession({ userId: "user-1", mode: "interview_self" });

    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("throws a ZodError on a missing field", async () => {
    await expect(createSession({ userId: "user-1" })).rejects.toThrow(ZodError);
  });

  it("throws a ZodError on an invalid mode", async () => {
    await expect(createSession({ userId: "user-1", mode: "not_a_mode" })).rejects.toThrow(ZodError);
  });
});

describe("createSession — warm soft-turn pre-warm (#246/#249)", () => {
  it.each(["interview_self", "interview_wants"] as const)(
    "creates one warm runner and eagerly prewarms it for %s, injecting it into the engine",
    async (mode) => {
      await createSession({ userId: "user-1", mode });

      // Exactly one warm runner created and its subprocess spawn kicked off up
      // front (#249), so it overlaps the instant fact questions.
      expect(createWarmSoftTurn).toHaveBeenCalledTimes(1);
      expect(warmInstances).toHaveLength(1);
      expect(warmInstances[0].prewarm).toHaveBeenCalledTimes(1);
      // The engine runs its soft turns through the warm runner, not a cold call.
      expect(engineInstances[0].runSoftTurn).toBe(warmInstances[0].softTurn);
    }
  );

  it("does not create a warm runner for pitch", async () => {
    await createSession({ userId: "user-1", mode: "pitch", matchId: "match-1" });
    expect(createWarmSoftTurn).not.toHaveBeenCalled();
    expect(warmInstances).toHaveLength(0);
  });

  it("does not create a warm runner for debrief", async () => {
    await createSession({ userId: "user-1", mode: "debrief", matchId: "match-1" });
    expect(createWarmSoftTurn).not.toHaveBeenCalled();
    expect(warmInstances).toHaveLength(0);
  });

  it("closes the warm runner when the interview completes", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_wants" });
    engineInstances[0].result = { reply: "locked in", phaseComplete: true };

    await sendMessage({ sessionId, message: "done" });

    expect(warmInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it("keeps the warm runner open while the interview is still going", async () => {
    const { sessionId } = await createSession({ userId: "user-1", mode: "interview_self" });
    engineInstances[0].result = { reply: "next question", phaseComplete: false };

    await sendMessage({ sessionId, message: "still answering" });

    expect(warmInstances[0].close).not.toHaveBeenCalled();
  });
});

describe("createSession — pitch mode", () => {
  it("routes pitch to the BarneyAgent with the requested mode and user", async () => {
    await createSession({ userId: "user-1", mode: "pitch", matchId: "match-1" });

    expect(agentInstances).toHaveLength(1);
    expect(agentInstances[0].mode).toBe("pitch");
    expect(agentInstances[0].userId).toBe("user-1");
    expect(engineInstances).toHaveLength(0);
  });

  it("throws a ZodError when matchId is missing for pitch mode", async () => {
    await expect(createSession({ userId: "user-1", mode: "pitch" })).rejects.toThrow(ZodError);
  });

  it("looks up the match and injects its rationale as RATIONALE_CONTEXT", async () => {
    vi.mocked(getMatchById).mockResolvedValue(
      makeMatch({ rationale: "You both love hiking." }) as never
    );

    await createSession({ userId: "user-1", mode: "pitch", matchId: "match-1" });

    expect(getMatchById).toHaveBeenCalledWith("match-1");
    expect(agentInstances[0].context?.RATIONALE_CONTEXT).toBe("You both love hiking.");
  });

  it("injects the matched partner's profile as MATCH_PROFILE so Barney can answer questions", async () => {
    await createSession({ userId: "user-1", mode: "pitch", matchId: "match-1" });

    // The partner is user-2 (match.userBId), loaded with their profile.
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-2" },
      include: { profile: true },
    });
    const matchProfile = agentInstances[0].context?.MATCH_PROFILE ?? "";
    // Real facts from the profile make it into Barney's context...
    expect(matchProfile).toContain("Pastry chef");
    expect(matchProfile).toContain("cooking with friends");
    expect(matchProfile).toContain("wants kids");
    // ...but identity does not — the name is saved for the Blind Date reveal.
    expect(matchProfile).not.toContain("Jordan");
  });

  it("still runs the pitch when the partner has no usable profile", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-2", name: "Jordan" } as never);

    await createSession({ userId: "user-1", mode: "pitch", matchId: "match-1" });

    expect(agentInstances).toHaveLength(1);
    expect(agentInstances[0].context?.RATIONALE_CONTEXT).toBeTruthy();
    expect(agentInstances[0].context?.MATCH_PROFILE).toContain("No detailed profile");
  });

  it("throws MatchNotFoundError for an unknown matchId", async () => {
    vi.mocked(getMatchById).mockResolvedValue(null);

    await expect(
      createSession({ userId: "user-1", mode: "pitch", matchId: "does-not-exist" })
    ).rejects.toThrow(MatchNotFoundError);
    expect(agentInstances).toHaveLength(0);
  });

  it("throws MatchNotFoundError when the match has no rationale (was actually rejected)", async () => {
    vi.mocked(getMatchById).mockResolvedValue(makeMatch({ rationale: null }) as never);

    await expect(
      createSession({ userId: "user-1", mode: "pitch", matchId: "match-1" })
    ).rejects.toThrow(MatchNotFoundError);
    expect(agentInstances).toHaveLength(0);
  });

  it("throws MatchOwnershipError when userId is not a participant in the match", async () => {
    vi.mocked(getMatchById).mockResolvedValue(
      makeMatch({ userAId: "user-a", userBId: "user-b" }) as never
    );

    await expect(
      createSession({ userId: "user-1", mode: "pitch", matchId: "match-1" })
    ).rejects.toThrow(MatchOwnershipError);
    expect(agentInstances).toHaveLength(0);
  });

  it("allows the match's userB to start a pitch session, not just userA", async () => {
    vi.mocked(getMatchById).mockResolvedValue(
      makeMatch({ userAId: "user-a", userBId: "user-1" }) as never
    );

    await expect(
      createSession({ userId: "user-1", mode: "pitch", matchId: "match-1" })
    ).resolves.toMatchObject({ sessionId: expect.any(String) });
  });
});

describe("createSession — debrief mode", () => {
  it("routes debrief to the BarneyAgent with the requested mode and user", async () => {
    await createSession({ userId: "user-1", mode: "debrief", matchId: "match-1" });

    expect(agentInstances).toHaveLength(1);
    expect(agentInstances[0].mode).toBe("debrief");
    expect(agentInstances[0].userId).toBe("user-1");
    expect(engineInstances).toHaveLength(0);
  });

  it("throws a ZodError when matchId is missing for debrief mode", async () => {
    await expect(createSession({ userId: "user-1", mode: "debrief" })).rejects.toThrow(ZodError);
  });

  it("looks up the match and the partner's name, and injects DATE_CONTEXT", async () => {
    vi.mocked(getMatchById).mockResolvedValue(
      makeMatch({ venue: "Aroma Coffee", dateTime: new Date("2026-06-07T20:00:00Z") }) as never
    );
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-2", name: "Jordan" } as never);

    await createSession({ userId: "user-1", mode: "debrief", matchId: "match-1" });

    expect(getMatchById).toHaveBeenCalledWith("match-1");
    expect(agentInstances[0].context?.DATE_CONTEXT).toContain("Jordan");
    expect(agentInstances[0].context?.DATE_CONTEXT).toContain("Aroma Coffee");
  });

  it("throws MatchNotFoundError for an unknown matchId", async () => {
    vi.mocked(getMatchById).mockResolvedValue(null);

    await expect(
      createSession({ userId: "user-1", mode: "debrief", matchId: "does-not-exist" })
    ).rejects.toThrow(MatchNotFoundError);
    expect(agentInstances).toHaveLength(0);
  });

  it("throws MatchNotFoundError when the match has no assigned Blind Date yet", async () => {
    vi.mocked(getMatchById).mockResolvedValue(makeMatch({ venue: null, dateTime: null }) as never);

    await expect(
      createSession({ userId: "user-1", mode: "debrief", matchId: "match-1" })
    ).rejects.toThrow(MatchNotFoundError);
    expect(agentInstances).toHaveLength(0);
  });

  it("throws MatchNotFoundError when the assigned Blind Date has not happened yet", async () => {
    vi.mocked(getMatchById).mockResolvedValue(
      makeMatch({ dateTime: new Date(Date.now() + 60_000) }) as never
    );

    await expect(
      createSession({ userId: "user-1", mode: "debrief", matchId: "match-1" })
    ).rejects.toThrow(MatchNotFoundError);
    expect(agentInstances).toHaveLength(0);
  });

  it("throws MatchOwnershipError when userId is not a participant in the match", async () => {
    vi.mocked(getMatchById).mockResolvedValue(
      makeMatch({ userAId: "user-a", userBId: "user-b" }) as never
    );

    await expect(
      createSession({ userId: "user-1", mode: "debrief", matchId: "match-1" })
    ).rejects.toThrow(MatchOwnershipError);
    expect(agentInstances).toHaveLength(0);
  });
});

// ADR-0037 — the language reaches the engine at construction, and an omitted
// one is left undefined so the engine's own default (Hebrew) applies. Keeping
// the product default in exactly one place is the point.
describe("createSession — interview language", () => {
  it("passes the requested language through to the engine", async () => {
    await createSession({ userId: "user-1", mode: "interview_self", language: "en" });
    expect(engineInstances[0].language).toBe("en");
  });

  it("passes nothing when the client sends no language, so the engine default applies", async () => {
    await createSession({ userId: "user-1", mode: "interview_self" });
    expect(engineInstances[0].language).toBeUndefined();
  });
});
