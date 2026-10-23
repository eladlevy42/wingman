import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunAgentQuery } = vi.hoisted(() => ({ mockRunAgentQuery: vi.fn() }));

vi.mock("./agentSdkClient", () => ({ runAgentQuery: mockRunAgentQuery }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((options) => options),
}));

// Captures the `onScore` callback each time NegotiationAgent asks for a
// createSaveScoreTool, so a test's runAgentQuery mock can simulate the SDK
// invoking it (or not, to exercise the re-ask/failure paths).
let lastOnScore: ((input: { score: number; rationale: string }) => void) | undefined;
vi.mock("./tools/saveScore", () => ({
  createSaveScoreTool: vi.fn((onScore: (input: { score: number; rationale: string }) => void) => {
    lastOnScore = onScore;
    return { name: "saveScore" };
  }),
}));

import type { UserProfile, WantedProfile } from "@wingman/shared";
import {
  NegotiationAgent,
  runNegotiation,
  formatProfileContext,
  TOTAL_TURNS,
  QUESTIONS_PER_AGENT,
  MATCH_THRESHOLD,
  NegotiationTurnFailure,
  DEALBREAKER_CONFIRMED_SENTINEL,
  earlyExitSurvivorNote,
  detectTurnViolations,
  type NegotiationParticipant,
} from "./negotiation.agent";

function makeParticipant(
  name: string,
  marker: string,
  overrides: Partial<NegotiationParticipant> = {}
): NegotiationParticipant {
  const profile = {
    age: 30,
    city: marker,
    country: "Wonderland",
    height: null,
    job: null,
    hometown: null,
    education: null,
    body_type: null,
    conflict_style: null,
    emotional_openness: null,
    treatment_of_others: null,
    personality_traits: [],
    wants_kids: null,
    kids_timeline: null,
    faith: null,
    current_motivation: null,
    life_vision: null,
    hobbies: [],
    typical_weekend: null,
    social_energy: null,
    social_circle: null,
    photoUrls: [],
  } as UserProfile;
  const wanted = {
    genderPreference: "both",
    ageRange: { min: 25, max: 40 },
    maxDistanceKm: 50,
    appearance: [],
    personality: [],
    lifestyle: [],
    dealbreakers: [`dealbreaker-${marker}`],
    preferences: [],
    compromises: [],
  } as WantedProfile;
  return { userId: `id-${name}`, name, gender: `gender-${marker}`, profile, wanted, ...overrides };
}

// A scoring call is one that wires up saveScore (mcpServers set); everything
// else is a plain negotiation turn.
function isScoringCall(args: { mcpServers?: unknown }): boolean {
  return args.mcpServers !== undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  lastOnScore = undefined;
});

describe("formatProfileContext", () => {
  it("injects only the participant's own profile into the prompt", () => {
    const alex = makeParticipant("Alex", "ALEX_CITY");
    const sam = makeParticipant("Sam", "SAM_CITY");

    const alexPrompt = formatProfileContext(alex);
    const samPrompt = formatProfileContext(sam);

    expect(alexPrompt).toContain("ALEX_CITY");
    expect(alexPrompt).not.toContain("SAM_CITY");
    expect(samPrompt).toContain("SAM_CITY");
    expect(samPrompt).not.toContain("ALEX_CITY");
    expect(alexPrompt).not.toContain("{{PROFILE_CONTEXT}}");
  });

  // Issue #317: the agent must be told its own human's gender — UserProfile has
  // no gender field, and agents left to infer it from genderPreference were
  // vetoing pairs the deterministic filter had already gender-verified.
  it("includes the participant's own gender in the prompt", () => {
    const alex = makeParticipant("Alex", "ALEX_CITY");

    const alexPrompt = formatProfileContext(alex);

    expect(alexPrompt).toContain('"gender": "gender-ALEX_CITY"');
    expect(alexPrompt).toContain("Prompt redacted in the public showcase version");
  });

  // Issue #299: merged debrief feedback rides into the agent's system prompt.
  it("includes feedbackFromPastDates when the participant has merged feedback", () => {
    const alex = makeParticipant("Alex", "ALEX_CITY", {
      feedback: {
        addedDealbreakers: ["FEEDBACK_DEALBREAKER_SMOKING"],
        removedDealbreakers: [],
        removedPreferences: ["tall"],
        addedPreferences: ["dog person"],
        compromiseUpdates: ["open to long distance"],
      },
    });

    const prompt = formatProfileContext(alex);

    // The quoted form is the JSON data block — the prompt's static instructions
    // mention the term unquoted, so this distinguishes data from prose.
    expect(prompt).toContain('"feedbackFromPastDates"');
    expect(prompt).toContain("FEEDBACK_DEALBREAKER_SMOKING");
    expect(prompt).toContain("dog person");
  });

  // Issue #341: a retracted dealbreaker alone must still surface the
  // feedbackFromPastDates block — it isn't "empty" just because the other
  // three buckets have nothing this round.
  it("includes feedbackFromPastDates when only removedDealbreakers is non-empty", () => {
    const alex = makeParticipant("Alex", "ALEX_CITY", {
      feedback: {
        addedDealbreakers: [],
        removedDealbreakers: ["FEEDBACK_RETRACTED_LATENESS"],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      },
    });

    const prompt = formatProfileContext(alex);

    expect(prompt).toContain('"feedbackFromPastDates"');
    expect(prompt).toContain("FEEDBACK_RETRACTED_LATENESS");
  });

  // A user with no FeedbackRounds merges to an all-empty delta — the context
  // must stay byte-identical to the historical no-feedback format.
  it("serializes an all-empty feedback delta identically to no feedback at all", () => {
    const without = formatProfileContext(makeParticipant("Alex", "ALEX_CITY"));
    const withEmpty = formatProfileContext(
      makeParticipant("Alex", "ALEX_CITY", {
        feedback: {
          addedDealbreakers: [],
          removedDealbreakers: [],
          removedPreferences: [],
          addedPreferences: [],
          compromiseUpdates: [],
        },
      })
    );

    expect(withEmpty).toBe(without);
    expect(withEmpty).not.toContain('"feedbackFromPastDates"');
  });
});

describe("runNegotiation loop", () => {
  it("executes exactly 8 negotiation turns plus 2 scoring turns", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: `turn-${call++}`, toolUses: [] };
    });

    const alex = makeParticipant("Alex", "ALEX_CITY");
    const sam = makeParticipant("Sam", "SAM_CITY");

    const { deliberationLog } = await runNegotiation(alex, sam);

    expect(TOTAL_TURNS).toBe(8);
    expect(deliberationLog).toHaveLength(TOTAL_TURNS);
    // +2 scoring calls, +2 rationale calls — both agents write a half (#340).
    expect(mockRunAgentQuery).toHaveBeenCalledTimes(TOTAL_TURNS + 4);

    const alexCalls = mockRunAgentQuery.mock.calls.filter(([args]) =>
      args.systemPrompt.includes("ALEX_CITY")
    );
    const samCalls = mockRunAgentQuery.mock.calls.filter(([args]) =>
      args.systemPrompt.includes("SAM_CITY")
    );
    expect(alexCalls).toHaveLength(QUESTIONS_PER_AGENT + 2);
    expect(samCalls).toHaveLength(QUESTIONS_PER_AGENT + 2);
  });

  it("records the deliberationLog in speaker-alternating order with correct labels", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: `msg-${call++}`, toolUses: [] };
    });

    const { deliberationLog } = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(deliberationLog.map((m) => m.speaker)).toEqual([
      "Alex's agent",
      "Sam's agent",
      "Alex's agent",
      "Sam's agent",
      "Alex's agent",
      "Sam's agent",
      "Alex's agent",
      "Sam's agent",
    ]);
    expect(deliberationLog.map((m) => m.content)).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
      "msg-5",
      "msg-6",
      "msg-7",
    ]);
  });

  // The opener never takes a turn after the closer's final message, so without
  // an explicit relay it would score blind to that last turn — often the answer
  // to the opener's own final question. relayClosingToOpener (default true)
  // pushes it into the opener's history before scoring.
  it("relays the closer's final turn into the opener's scoring context by default", async () => {
    const FINAL = "CLOSER_FINAL_MESSAGE";
    let turn = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 5, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      turn += 1;
      // Default openerSide "a": Alex opens, Sam speaks the 8th (last) turn.
      return { text: turn === TOTAL_TURNS ? FINAL : `turn-${turn}`, toolUses: [] };
    });

    await runNegotiation(makeParticipant("Alex", "ALEX_CITY"), makeParticipant("Sam", "SAM_CITY"));

    const openerScoringPrompt = mockRunAgentQuery.mock.calls
      .filter(([a]) => isScoringCall(a) && a.systemPrompt.includes("ALEX_CITY"))
      .map(([a]) => a.prompt as string)[0];
    expect(openerScoringPrompt).toContain(FINAL);
  });

  it("leaves the opener blind to the closer's final turn when relayClosingToOpener is false", async () => {
    const FINAL = "CLOSER_FINAL_MESSAGE";
    let turn = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 5, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      turn += 1;
      return { text: turn === TOTAL_TURNS ? FINAL : `turn-${turn}`, toolUses: [] };
    });

    await runNegotiation(makeParticipant("Alex", "ALEX_CITY"), makeParticipant("Sam", "SAM_CITY"), {
      relayClosingToOpener: false,
    });

    const scoringPrompt = (marker: string) =>
      mockRunAgentQuery.mock.calls
        .filter(([a]) => isScoringCall(a) && a.systemPrompt.includes(marker))
        .map(([a]) => a.prompt as string)[0];
    // Opener (Alex) never saw the closer's final turn...
    expect(scoringPrompt("ALEX_CITY")).not.toContain(FINAL);
    // ...but the closer (Sam) spoke it, so it is in its own scoring context — a
    // control proving the difference is the blind opener, not a missing turn.
    expect(scoringPrompt("SAM_CITY")).toContain(FINAL);
  });

  it("strips echoed relay framing and speaker prefixes from logged content (#399)", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      // Simulate a model that echoes the relay wrapper and User:/Assistant:
      // prefixes back into its own reply.
      return {
        text: "User: RELAY_REDACTED\nYes. My human enjoys hiking.\nREPLY_REDACTED",
        toolUses: [],
      };
    });

    const { deliberationLog } = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY"),
      { turns: 2 }
    );

    for (const message of deliberationLog) {
      expect(message.content).toBe("Yes. My human enjoys hiking.");
      expect(message.content).not.toMatch(/^(User|Assistant):/m);
      expect(message.content).not.toContain("RELAY_REDACTED");
      expect(message.content).not.toContain("REPLY_REDACTED");
    }
  });

  it("feeds each agent only its own human's profile", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: "ok", toolUses: [] };
    });

    await runNegotiation(makeParticipant("Alex", "ALEX_CITY"), makeParticipant("Sam", "SAM_CITY"));

    for (const [args] of mockRunAgentQuery.mock.calls) {
      const hasAlex = args.systemPrompt.includes("ALEX_CITY");
      const hasSam = args.systemPrompt.includes("SAM_CITY");
      expect(hasAlex).not.toBe(hasSam);
    }
  });

  it("wires up the saveScore tool only on the scoring calls", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: "ok", toolUses: [] };
    });

    await runNegotiation(makeParticipant("Alex", "ALEX_CITY"), makeParticipant("Sam", "SAM_CITY"));

    const scoringCalls = mockRunAgentQuery.mock.calls.filter(([args]) => isScoringCall(args));
    expect(scoringCalls).toHaveLength(2);
    for (const [args] of scoringCalls) {
      expect(args.allowedTools).toEqual(["mcp__wingman__saveScore"]);
    }
  });

  it("scores independently, does not leak scores, and computes matched", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: args.systemPrompt.includes("ALEX_CITY") ? 8 : 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: "ok", toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(result.scoreA).toBe(8);
    expect(result.scoreB).toBe(7);
    expect(result.matched).toBe(true);
    // Both agents' halves, joined (#340).
    expect(result.rationale).toBe("ok\n\nok");
  });

  it("does not match when either score is below the threshold", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: args.systemPrompt.includes("ALEX_CITY") ? 8 : 6, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: "ok", toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(result.scoreA).toBe(8);
    expect(result.scoreB).toBe(6);
    expect(result.matched).toBe(false);
    expect(result.rationale).toBeNull();
  });

  // Issue #340: a single-agent rationale is necessarily one-sided (grounded
  // only in that agent's own human's profile) — both agents must contribute.
  it("asks both agents to write their own half of the rationale when matched", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      const text = args.systemPrompt.includes("ALEX_CITY")
        ? "Alex loves hiking and deep conversation."
        : "Sam is warm, funny, and a great listener.";
      return { text, toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    const rationaleCalls = mockRunAgentQuery.mock.calls.filter(
      ([args]) => !isScoringCall(args) && args.prompt.includes("RATIONALE_REDACTED")
    );
    expect(rationaleCalls).toHaveLength(2);
    expect(rationaleCalls.some(([args]) => args.systemPrompt.includes("ALEX_CITY"))).toBe(true);
    expect(rationaleCalls.some(([args]) => args.systemPrompt.includes("SAM_CITY"))).toBe(true);
    expect(result.rationale).toBe(
      "Alex loves hiking and deep conversation.\n\nSam is warm, funny, and a great listener."
    );
  });

  it("does not write a rationale for either agent when not matched", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 5, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: "ok", toolUses: [] };
    });

    await runNegotiation(makeParticipant("Alex", "ALEX_CITY"), makeParticipant("Sam", "SAM_CITY"));

    const rationaleCalls = mockRunAgentQuery.mock.calls.filter(
      ([args]) => !isScoringCall(args) && args.prompt.includes("RATIONALE_REDACTED")
    );
    expect(rationaleCalls).toHaveLength(0);
  });

  // Issue #339: a mid-negotiation turn failure must not discard the transcript
  // (and paid API spend) already produced by the turns that succeeded before it.
  it("throws a NegotiationTurnFailure carrying the partial log instead of discarding it", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      call++;
      if (call === 3) throw new Error("agent query failed — server_error");
      return { text: `turn-${call}`, toolUses: [] };
    });

    const failure = (await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    ).catch((error: unknown) => error)) as NegotiationTurnFailure;

    expect(failure).toBeInstanceOf(NegotiationTurnFailure);
    // Turns 1 and 2 succeeded and were logged before turn 3 threw.
    expect(failure.deliberationLog).toHaveLength(2);
    expect(failure.deliberationLog.map((m) => m.content)).toEqual(["turn-1", "turn-2"]);
    expect(failure.message).toContain("server_error");
    expect(failure.turnError).toBeInstanceOf(Error);
    // No scoring call happened — the loop never reached it.
    const scoringCalls = mockRunAgentQuery.mock.calls.filter(([args]) => isScoringCall(args));
    expect(scoringCalls).toHaveLength(0);
  });

  it("still throws a NegotiationTurnFailure with the full log when scoring (not a negotiation turn) fails", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        throw new Error("scoring call failed");
      }
      call++;
      return { text: `turn-${call}`, toolUses: [] };
    });

    const failure = (await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    ).catch((error: unknown) => error)) as NegotiationTurnFailure;

    expect(failure).toBeInstanceOf(NegotiationTurnFailure);
    // Every negotiation turn succeeded — the full transcript is still captured.
    expect(failure.deliberationLog).toHaveLength(TOTAL_TURNS);
  });
});

describe("runNegotiation early exit (#338)", () => {
  it("stops before all turns run once an agent confirms a dealbreaker, and still scores both agents", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 2, rationale: "dealbreaker hit" });
        return { text: "", toolUses: [] };
      }
      const text = call === 1 ? `Confirmed. ${DEALBREAKER_CONFIRMED_SENTINEL}` : `turn-${call}`;
      call++;
      return { text, toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    // turn 0 (Alex opens) + turn 1 (Sam confirms) — stops well short of TOTAL_TURNS (8).
    expect(result.deliberationLog).toHaveLength(2);
    // Both agents still get scored despite the early stop.
    const scoringCalls = mockRunAgentQuery.mock.calls.filter(([args]) => isScoringCall(args));
    expect(scoringCalls).toHaveLength(2);
    expect(result.scoreA).toBe(2);
    expect(result.scoreB).toBe(2);
  });

  it("strips the sentinel from the logged transcript content", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 2, rationale: "dealbreaker hit" });
        return { text: "", toolUses: [] };
      }
      const text =
        call === 1 ? `They smoke daily. ${DEALBREAKER_CONFIRMED_SENTINEL}` : `turn-${call}`;
      call++;
      return { text, toolUses: [] };
    });

    const { deliberationLog } = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(deliberationLog[1].content).toBe("They smoke daily.");
    expect(deliberationLog[1].content).not.toContain(DEALBREAKER_CONFIRMED_SENTINEL);
  });

  it("ignores the sentinel on the opening turn — a question can't confirm anything yet", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      const text = call === 0 ? `Bogus opener. ${DEALBREAKER_CONFIRMED_SENTINEL}` : `turn-${call}`;
      call++;
      return { text, toolUses: [] };
    });

    const { deliberationLog } = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(deliberationLog).toHaveLength(TOTAL_TURNS);
    // Turn 1 is the other agent's very next call — its prompt carries turn 0's
    // reply via `incoming`. The raw sentinel must not leak into it.
    const otherAgentNextCall = mockRunAgentQuery.mock.calls[1][0] as { prompt: string };
    expect(otherAgentNextCall.prompt).toContain("Bogus opener");
    expect(otherAgentNextCall.prompt).not.toContain(DEALBREAKER_CONFIRMED_SENTINEL);
  });

  it("relays the terminating message to only the surviving agent before it scores (#420, P3)", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 3, rationale: "own dealbreaker violated" });
        return { text: "", toolUses: [] };
      }
      // Sam (agentB, turn 1) confirms the dealbreaker; Alex (agentA) survives.
      const text =
        call === 1 ? `They do not want kids. ${DEALBREAKER_CONFIRMED_SENTINEL}` : `turn-${call}`;
      call++;
      return { text, toolUses: [] };
    });

    await runNegotiation(makeParticipant("Alex", "ALEX_CITY"), makeParticipant("Sam", "SAM_CITY"));

    const scoringPrompts = mockRunAgentQuery.mock.calls
      .filter(([args]) => isScoringCall(args))
      .map(([args]) => (args as { prompt: string }).prompt);
    // The survivor's note carries the exact sentinel-stripped killing message
    // (so it can pick the right cap), and only the survivor (the opener Alex,
    // "turn-0") gets it — not the emitter (Sam).
    const withNote = scoringPrompts.filter((p) =>
      p.includes(earlyExitSurvivorNote("They do not want kids."))
    );
    expect(withNote).toHaveLength(1);
    expect(withNote[0]).toContain("turn-0");
  });
});

describe("runNegotiation opener side (#420, P7b)", () => {
  it("openerSide 'b' makes B speak first while keeping agent identity labels", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      const text = `turn-${call}`;
      call++;
      return { text, toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY"),
      { openerSide: "b" }
    );

    // B (Sam) opens; the two still alternate and keep their own labels.
    expect(result.deliberationLog[0].speaker).toBe("Sam's agent");
    expect(result.deliberationLog[1].speaker).toBe("Alex's agent");
  });

  it("strips echoed framing lines even when paraphrased/truncated (#420, P1)", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      // turn 0 echoes a garbled/truncated version of the framing opener that
      // exact-line matching would miss; the prefix strip must still remove it.
      const text =
        call === 0
          ? "Does their person want kids?\nREPLY_REDACTED then ask one contiesponse"
          : `turn-${call}`;
      call++;
      return { text, toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(result.deliberationLog[0].content).toBe("Does their person want kids?");
    expect(result.deliberationLog[0].content).not.toContain("REPLY_REDACTED");
  });

  it("defaults to A opening when openerSide is omitted", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      const text = `turn-${call}`;
      call++;
      return { text, toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(result.deliberationLog[0].speaker).toBe("Alex's agent");
    expect(result.deliberationLog[1].speaker).toBe("Sam's agent");
  });
});

describe("runNegotiation final turn framing (#380)", () => {
  it("frames the last turn as a closing assessment, not a new question", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 8, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: "ok", toolUses: [] };
    });

    await runNegotiation(makeParticipant("Alex", "ALEX_CITY"), makeParticipant("Sam", "SAM_CITY"));

    const negotiationCalls = mockRunAgentQuery.mock.calls.filter(
      ([args]) => !isScoringCall(args) && !args.prompt.includes("RATIONALE_REDACTED")
    );
    expect(negotiationCalls).toHaveLength(TOTAL_TURNS);

    // Each call's prompt is the full transcript so far, ending with this
    // turn's own incoming instruction — check that trailing instruction,
    // not the whole transcript (earlier turns' instructions persist in it).
    const lastTurnCall = negotiationCalls[TOTAL_TURNS - 1][0] as { prompt: string };
    expect(lastTurnCall.prompt.trimEnd()).toMatch(/CLOSING_REDACTED$/);

    // The second-to-last turn uses the ordinary reply framing (#420, P1:
    // "write only your own reply … do not continue, quote, or invent theirs").
    const secondToLastCall = negotiationCalls[TOTAL_TURNS - 2][0] as { prompt: string };
    expect(secondToLastCall.prompt.trimEnd()).toMatch(/REPLY_REDACTED$/);
  });
});

describe("detectTurnViolations (#420)", () => {
  it("flags a bare numeric score line", () => {
    expect(detectTurnViolations("4\n\nNo dealbreaker was violated.")).toContain("bare-score-line");
  });

  it("flags an explicit numeric score statement", () => {
    expect(detectTurnViolations("My score is 8 for this match.")).toContain("score-statement");
    expect(detectTurnViolations("The final match score is 5.5")).toContain("score-statement");
  });

  it("flags a staged / fabricated other-side turn", () => {
    expect(
      detectTurnViolations("The other agent responded with the score: 7. Barney says: matched.")
    ).toContain("staged-other-side");
  });

  it("does not flag a clean in-character reply", () => {
    expect(
      detectTurnViolations("My human wants kids soon. Does your human share Jewish observance?")
    ).toEqual([]);
  });

  // Quiet ventriloquism (#422): a turn that asks, then writes the answer, then
  // asks again — staging a whole exchange with no "the other agent responded"
  // framing, so the loud detectors above never fire. Shape taken from a real
  // contaminated run0 turn (Eitan's agent inventing Maya's weekend).
  it("flags a staged Q&A exchange — question, invented answer, next question", () => {
    expect(
      detectTurnViolations(
        "My human is spiritual but not religious in practice.\n\n" +
          "What is their human's typical weekend like?\n\n" +
          "Her typical weekend involves quiet, homebody activities and low-key social time.\n\n" +
          "What are their human's personality traits?"
      )
    ).toContain("staged-qa-exchange");
  });

  it("flags a staged exchange even when the invented answer uses 'My human' framing", () => {
    // Real run0 shape: Maya's agent answered its own question AS Eitan's agent.
    expect(
      detectTurnViolations(
        "Her dealbreakers are unkindness and not wanting kids. What does their human do for work?\n\n" +
          "My human is a chef — runs his own kitchen and sees cooking as an art form.\n\n" +
          "Does their human have creative passions outside of work?"
      )
    ).toContain("staged-qa-exchange");
  });

  it("does not flag a protocol-clean turn that answers first and ends with its question", () => {
    expect(
      detectTurnViolations(
        "My human handles conflict directly — she'd rather resolve it than let it fester.\n\n" +
          "How emotionally open is their human?"
      )
    ).toEqual([]);
  });

  it("does not flag a multi-part question (adjacent question lines, no answer between)", () => {
    expect(
      detectTurnViolations(
        "My human wants kids soon.\n\nDoes their human want kids?\nAnd if so, on what timeline?"
      )
    ).toEqual([]);
  });

  it("does not flag an inline rhetorical question that continues as prose", () => {
    // The question mark is mid-line, so the line is prose, not a question line.
    expect(
      detectTurnViolations(
        "Does she avoid conflict? No — my human addresses it head-on and talks things through.\n\n" +
          "What is their human's approach to faith?"
      )
    ).toEqual([]);
  });
});

describe("runNegotiation turn-level protocol retry (#420)", () => {
  it("re-asks once and logs the rewritten reply when a turn states a score", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      call++;
      // First opener attempt leaks a score; the retry rewrites it clean.
      if (call === 1) return { text: "Score: 8. I think this is great.", toolUses: [] };
      if (call === 2) return { text: "Does their person want kids?", toolUses: [] };
      return { text: `turn-${call}`, toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    // The contaminated attempt never reaches deliberationLog; the rewrite does.
    expect(result.deliberationLog[0].content).toBe("Does their person want kids?");
    expect(result.deliberationLog[0].content).not.toContain("Score:");
    // The firing is persisted on the result (#422), not just console.warn'd —
    // attributed to the agent whose turn tripped it (Alex opens by default).
    expect(result.guardRetries).toEqual([{ speaker: "Alex's agent", kinds: ["score-statement"] }]);
  });

  // #422: staged-qa-exchange is DETECTION-ONLY. Two 10-couple sweeps with it
  // driving re-asks measured 16/20 match-decision accuracy against 20/20
  // without, so it must not disturb the negotiation — it is recorded in the
  // eval log's quietViolations instead. See docs/adr/0030.
  it("does NOT re-ask on a staged Q&A exchange — that kind is detection-only", async () => {
    const STAGED =
      "Does their human want kids?\n\n" +
      "My human wants kids and hopes to start a family within two years.\n\n" +
      "What about their approach to faith?";
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: STAGED, toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    const negotiationCalls = mockRunAgentQuery.mock.calls.filter(
      ([args]) => !isScoringCall(args) && !args.prompt.includes("RATIONALE_REDACTED")
    );
    // No extra calls beyond the turns themselves — the guard stayed out of it.
    expect(negotiationCalls).toHaveLength(TOTAL_TURNS);
    expect(result.guardRetries).toEqual([]);
    // The detector still sees it; it just no longer drives a retry.
    expect(detectTurnViolations(STAGED)).toContain("staged-qa-exchange");
  });

  // #424: the experimental arm of the paired A/B re-enables that retry. Same
  // input as the test above — the ONLY difference is the flag, which is the
  // property the experiment depends on for a clean attribution.
  it("DOES re-ask on a staged Q&A exchange when guardQuietVentriloquism is set (#424)", async () => {
    const STAGED =
      "Does their human want kids?\n\n" +
      "My human wants kids and hopes to start a family within two years.\n\n" +
      "What about their approach to faith?";
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      call++;
      // First turn stages an exchange; the retry rewrites it clean.
      return call === 1
        ? { text: STAGED, toolUses: [] }
        : { text: "Does their human want kids?", toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY"),
      { guardQuietVentriloquism: true }
    );

    expect(result.guardRetries).toEqual([
      { speaker: "Alex's agent", kinds: ["staged-qa-exchange"] },
    ]);
    // The staged attempt never reaches the transcript; the rewrite does.
    expect(result.deliberationLog[0].content).toBe("Does their human want kids?");
  });

  it("still re-asks on a loud violation regardless of the #424 flag", async () => {
    for (const guardQuietVentriloquism of [false, true]) {
      vi.clearAllMocks();
      let call = 0;
      mockRunAgentQuery.mockImplementation(async (args) => {
        if (isScoringCall(args)) {
          lastOnScore?.({ score: 7, rationale: "ok" });
          return { text: "", toolUses: [] };
        }
        call++;
        if (call === 1) return { text: "My score is 8 for this match.", toolUses: [] };
        return { text: `turn-${call}`, toolUses: [] };
      });

      const result = await runNegotiation(
        makeParticipant("Alex", "ALEX_CITY"),
        makeParticipant("Sam", "SAM_CITY"),
        { guardQuietVentriloquism }
      );

      expect(result.guardRetries).toEqual([
        { speaker: "Alex's agent", kinds: ["score-statement"] },
      ]);
    }
  });

  it("returns an empty guardRetries list on a clean negotiation (#422)", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 5, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      return { text: "ok", toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(result.guardRetries).toEqual([]);
  });

  it("does NOT retry a benign echo of the 'The other agent responded:' framing line", async () => {
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      // Echoes the exact framing line (benign, common) + clean content. Detection
      // runs on the stripped reply, so this must not trip staged-other-side.
      return {
        text: "REPLY_REDACTED\n\nMy human wants kids. Does theirs?",
        toolUses: [],
      };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    const negotiationCalls = mockRunAgentQuery.mock.calls.filter(
      ([args]) => !isScoringCall(args) && !args.prompt.includes("RATIONALE_REDACTED")
    );
    // No spurious retry: exactly TOTAL_TURNS negotiation calls (rationale calls,
    // which fire because 7/7 matches, are excluded), not more.
    expect(negotiationCalls).toHaveLength(TOTAL_TURNS);
    expect(result.deliberationLog[0].content).toBe("My human wants kids. Does theirs?");
  });

  it("strips an echoed protocol-guard re-ask line from logged content", async () => {
    let call = 0;
    mockRunAgentQuery.mockImplementation(async (args) => {
      if (isScoringCall(args)) {
        lastOnScore?.({ score: 7, rationale: "ok" });
        return { text: "", toolUses: [] };
      }
      call++;
      const text =
        call === 1 ? "TURN_PROTOCOL_REDACTED\nDoes their person want kids?" : `turn-${call}`;
      return { text, toolUses: [] };
    });

    const result = await runNegotiation(
      makeParticipant("Alex", "ALEX_CITY"),
      makeParticipant("Sam", "SAM_CITY")
    );

    expect(result.deliberationLog[0].content).toBe("Does their person want kids?");
    expect(result.deliberationLog[0].content).not.toContain("broke the negotiation protocol");
  });
});

describe("MATCH_THRESHOLD", () => {
  it("is 7", () => {
    expect(MATCH_THRESHOLD).toBe(7);
  });
});

describe("NegotiationAgent.score", () => {
  it("returns the score from a valid saveScore call", async () => {
    mockRunAgentQuery.mockImplementationOnce(async () => {
      lastOnScore?.({ score: 8, rationale: "Strong alignment." });
      return { text: "", toolUses: [] };
    });

    const agent = new NegotiationAgent("system", "u-1");
    const result = await agent.score();

    expect(result.score).toBe(8);
    expect(mockRunAgentQuery).toHaveBeenCalledTimes(1);
  });

  it("re-asks once when the model doesn't call saveScore, and recovers", async () => {
    mockRunAgentQuery
      .mockImplementationOnce(async () => ({ text: "I refuse to use tools.", toolUses: [] }))
      .mockImplementationOnce(async () => {
        lastOnScore?.({ score: 6, rationale: "Acceptable, not strong." });
        return { text: "", toolUses: [] };
      });

    const agent = new NegotiationAgent("system", "u-1");
    const result = await agent.score();

    expect(result.score).toBe(6);
    expect(mockRunAgentQuery).toHaveBeenCalledTimes(2);
  });

  it("throws after the re-ask also fails to call saveScore", async () => {
    mockRunAgentQuery.mockImplementation(async () => ({ text: "still refusing", toolUses: [] }));

    const agent = new NegotiationAgent("system", "u-1");

    await expect(agent.score()).rejects.toThrow(/did not call saveScore despite the re-ask/i);
    expect(mockRunAgentQuery).toHaveBeenCalledTimes(2);
  });
});

describe("NegotiationAgent.writeRationale", () => {
  it("returns the model's text after score()", async () => {
    mockRunAgentQuery
      .mockImplementationOnce(async () => {
        lastOnScore?.({ score: 8, rationale: "Strong alignment." });
        return { text: "", toolUses: [] };
      })
      .mockImplementationOnce(async () => ({
        text: "Great match, shared values and easy rapport.",
        toolUses: [],
      }));

    const agent = new NegotiationAgent("system", "u-1");
    await agent.score();
    const rationale = await agent.writeRationale();

    expect(rationale).toBe("Great match, shared values and easy rapport.");
    expect(mockRunAgentQuery).toHaveBeenCalledTimes(2);
  });

  it("throws when called before score()", async () => {
    const agent = new NegotiationAgent("system", "u-1");

    await expect(agent.writeRationale()).rejects.toThrow(/before score/i);
    expect(mockRunAgentQuery).not.toHaveBeenCalled();
  });

  it("throws when the model returns no text", async () => {
    mockRunAgentQuery
      .mockImplementationOnce(async () => {
        lastOnScore?.({ score: 8, rationale: "Strong alignment." });
        return { text: "", toolUses: [] };
      })
      .mockImplementationOnce(async () => ({ text: "   ", toolUses: [] }));

    const agent = new NegotiationAgent("system", "u-1");
    await agent.score();

    await expect(agent.writeRationale()).rejects.toThrow(/no text from the model/i);
  });
});

describe("NegotiationAgent.turn", () => {
  it("returns the agent query's text", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({ text: "recovered", toolUses: [] });

    const agent = new NegotiationAgent("system", "u-1");
    const result = await agent.turn("hello");

    expect(result.text).toBe("recovered");
    expect(mockRunAgentQuery).toHaveBeenCalledTimes(1);
  });

  it("propagates errors from the agent query (retry/auth/truncation live in agentSdkClient)", async () => {
    mockRunAgentQuery.mockRejectedValueOnce(new Error("boom"));

    const agent = new NegotiationAgent("system", "u-1");
    await expect(agent.turn("hello")).rejects.toThrow("boom");
  });
});
