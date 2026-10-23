import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { EvalRunConfigSchema } from "@wingman/shared";
import type { EvalRunContext } from "./types";
import { runTrack3 } from "./track3.service";

const {
  mockFindMany,
  mockSendMessage,
  mockProfileFindUnique,
  mockProfileUpdate,
  mockProfileDeleteMany,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockSendMessage: vi.fn(),
  mockProfileFindUnique: vi.fn(),
  mockProfileUpdate: vi.fn(),
  mockProfileDeleteMany: vi.fn(),
}));

vi.mock("@wingman/database", () => ({
  prisma: {
    seedTranscript: {
      findMany: mockFindMany,
    },
    // runTrack3 snapshots/restores the Profile row around each row's
    // extraction so replaying a seed transcript can't corrupt the real
    // ground-truth Profile the saveProfile tool writes to — see
    // withProfileSnapshot in track3.service.ts.
    profile: {
      findUnique: mockProfileFindUnique,
      update: mockProfileUpdate,
      deleteMany: mockProfileDeleteMany,
    },
  },
}));

// Mirrors BarneyAgent's public shape (EventEmitter + sendMessage + getUsage)
// so runTrack3's `agent.on("toolCall", ...)` / `await agent.sendMessage(...)`
// / `agent.getUsage()` flow works unmodified — see barney.agent.ts.
vi.mock("../../agents/barney.agent", () => ({
  BarneyAgent: class MockBarneyAgent extends EventEmitter {
    constructor(
      public mode: string,
      public userId: string
    ) {
      super();
    }
    sendMessage(text: string) {
      return mockSendMessage(text, this);
    }
    getUsage() {
      return { costUsd: 0.003, durationMs: 400 };
    }
  },
}));

// zod's uuid() only checks the 8-4-4-4-12 hex shape, not RFC version/variant
// nibbles, so plain hex-padded ids are valid without pulling in a uuid lib.
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function makeCtx(overrides: Partial<EvalRunContext> = {}): EvalRunContext {
  return {
    config: EvalRunConfigSchema.parse({}),
    shouldStop: () => false,
    onCase: () => {},
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    age: 30,
    city: "Tel Aviv",
    country: "Israel",
    height: "180cm",
    job: "engineer",
    hometown: "Haifa",
    education: "Computer Science",
    body_type: "athletic",
    conflict_style: "direct",
    emotional_openness: "high",
    treatment_of_others: "kind",
    personality_traits: ["funny", "ambitious"],
    wants_kids: true,
    kids_timeline: "soon",
    faith: "none",
    current_motivation: "career",
    life_vision: "stable",
    hobbies: [{ name: "climbing", centrality: "high", solo_or_social: "social" }],
    typical_weekend: "hiking",
    social_energy: "extrovert",
    social_circle: "small",
    photoUrls: [],
    ...overrides,
  };
}

function seedTranscript(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(1),
    userId: uuid(2),
    rawTranscript: "the whole conversation, replayed as one turn",
    expectedStructuredProfile: JSON.stringify(profile()),
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no pre-existing Profile row for the seed user, matching a fresh
  // seed database. Individual tests override this to assert restore behavior.
  mockProfileFindUnique.mockResolvedValue(null);
});

describe("runTrack3", () => {
  it("returns one case per seed transcript, with one field row per profile field", async () => {
    vi.mocked(mockFindMany).mockResolvedValue([seedTranscript()]);
    mockSendMessage.mockImplementation(async (_text, agent) => {
      agent.emit("toolCall", { name: "saveProfile", input: profile(), result: {} });
      return "ok";
    });

    const result = await runTrack3(makeCtx());

    expect(result).toHaveLength(1);
    expect(result[0].fields).toHaveLength(Object.keys(profile()).length);
    expect(result[0].fields.every((f) => f.match)).toBe(true);
    expect(result[0].matchCount).toBe(result[0].fields.length);
    expect(result[0].costUsd).toBeCloseTo(0.003);
  });

  it("flags a mismatched scalar field", async () => {
    vi.mocked(mockFindMany).mockResolvedValue([seedTranscript()]);
    mockSendMessage.mockImplementation(async (_text, agent) => {
      agent.emit("toolCall", { name: "saveProfile", input: profile({ age: 99 }), result: {} });
      return "ok";
    });

    const result = await runTrack3(makeCtx());

    const ageRow = result[0].fields.find((f) => f.field === "age");
    expect(ageRow?.match).toBe(false);
    expect(ageRow?.expected).toBe(30);
    expect(ageRow?.actual).toBe(99);
    expect(result[0].matchCount).toBe(result[0].fields.length - 1);
  });

  it("matches array fields regardless of object key order", async () => {
    vi.mocked(mockFindMany).mockResolvedValue([
      seedTranscript({
        expectedStructuredProfile: JSON.stringify(
          profile({ hobbies: [{ name: "climbing", centrality: "high", solo_or_social: "social" }] })
        ),
      }),
    ]);
    mockSendMessage.mockImplementation(async (_text, agent) => {
      agent.emit("toolCall", {
        name: "saveProfile",
        // Same hobby, keys in a different order than `expected`.
        input: profile({
          hobbies: [{ solo_or_social: "social", name: "climbing", centrality: "high" }],
        }),
        result: {},
      });
      return "ok";
    });

    const result = await runTrack3(makeCtx());

    expect(result[0].fields.find((f) => f.field === "hobbies")?.match).toBe(true);
  });

  it("marks every field as a mismatch when saveProfile is never called", async () => {
    vi.mocked(mockFindMany).mockResolvedValue([seedTranscript()]);
    mockSendMessage.mockResolvedValue("no tool call this turn");

    const result = await runTrack3(makeCtx());

    expect(result[0].fields.length).toBeGreaterThan(0);
    expect(result[0].fields.every((f) => f.match === false)).toBe(true);
    expect(result[0].fields.every((f) => f.actual === undefined)).toBe(true);
    expect(result[0].matchCount).toBe(0);
  });

  it("runs for every seed transcript and preserves per-user grouping", async () => {
    const transcripts = [
      seedTranscript({ id: uuid(1), userId: uuid(11) }),
      seedTranscript({ id: uuid(2), userId: uuid(12) }),
      seedTranscript({ id: uuid(3), userId: uuid(13) }),
    ];
    vi.mocked(mockFindMany).mockResolvedValue(transcripts);
    mockSendMessage.mockImplementation(async (_text, agent) => {
      agent.emit("toolCall", { name: "saveProfile", input: profile(), result: {} });
      return "ok";
    });

    const result = await runTrack3(makeCtx());

    const userIds = new Set(result.map((r) => r.userId));
    expect(userIds).toEqual(new Set(transcripts.map((t) => t.userId)));
  });

  // Acceptance criterion: "Runs for all 25 seed transcripts — verified by
  // integration test." Exercises the full service loop (DB read -> per-row
  // agent call -> field comparison -> schema validation) across all 25 rows;
  // BarneyAgent is faked (see mock above) to keep this deterministic and
  // free of real LLM calls.
  it("processes all 25 seed transcripts end to end", async () => {
    const transcripts = Array.from({ length: 25 }, (_, i) =>
      seedTranscript({ id: uuid(i + 1), userId: uuid(i + 100) })
    );
    vi.mocked(mockFindMany).mockResolvedValue(transcripts);
    mockSendMessage.mockImplementation(async (_text, agent) => {
      agent.emit("toolCall", { name: "saveProfile", input: profile(), result: {} });
      return "ok";
    });

    const result = await runTrack3(makeCtx());

    const userIds = new Set(result.map((r) => r.userId));
    expect(userIds.size).toBe(25);
    expect(result).toHaveLength(25);
  });

  // #316: a bare replay of a short seed transcript reads as an interview still
  // in progress, so the model asks a follow-up question instead of calling
  // saveProfile — every case then scores 0/N. Appending an explicit
  // closing note makes the replay unambiguous.
  it("appends a closing system note to the replayed transcript", async () => {
    vi.mocked(mockFindMany).mockResolvedValue([
      seedTranscript({ rawTranscript: "Q: How old are you? A: 30." }),
    ]);
    mockSendMessage.mockImplementation(async (_text, agent) => {
      agent.emit("toolCall", { name: "saveProfile", input: profile(), result: {} });
      return "ok";
    });

    await runTrack3(makeCtx());

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^Q: How old are you\? A: 30\.[\s\S]*SYSTEM NOTE[\s\S]*saveProfile/),
      expect.anything()
    );
  });

  it("returns an empty array when there are no seed transcripts", async () => {
    vi.mocked(mockFindMany).mockResolvedValue([]);

    const result = await runTrack3(makeCtx());

    expect(result).toEqual([]);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("stops early when the context signals shouldStop", async () => {
    vi.mocked(mockFindMany).mockResolvedValue([seedTranscript(), seedTranscript({ id: uuid(2) })]);

    const result = await runTrack3(makeCtx({ shouldStop: () => true }));

    expect(result).toEqual([]);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  // The saveProfile tool BarneyAgent invokes writes straight to the real
  // Profile row for seedTranscript.userId (see createSaveProfileTool). Track
  // 3 must not leave that mutation behind — it would silently corrupt the
  // ground-truth data Track 1 and the matching engine read.
  it("restores a pre-existing Profile row after extraction", async () => {
    const existingProfile = {
      id: uuid(9),
      userId: uuid(2),
      rawTranscript: "original transcript",
      structuredData: JSON.stringify({ some: "ground-truth data" }),
      status: "COMPLETED",
    };
    mockProfileFindUnique.mockResolvedValue(existingProfile);
    vi.mocked(mockFindMany).mockResolvedValue([seedTranscript()]);
    mockSendMessage.mockImplementation(async (_text, agent) => {
      agent.emit("toolCall", { name: "saveProfile", input: profile(), result: {} });
      return "ok";
    });

    await runTrack3(makeCtx());

    expect(mockProfileUpdate).toHaveBeenCalledWith({
      where: { userId: uuid(2) },
      data: {
        rawTranscript: existingProfile.rawTranscript,
        structuredData: existingProfile.structuredData,
        status: existingProfile.status,
      },
    });
    expect(mockProfileDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes the Profile row created during extraction when none existed before", async () => {
    mockProfileFindUnique.mockResolvedValue(null);
    vi.mocked(mockFindMany).mockResolvedValue([seedTranscript()]);
    mockSendMessage.mockImplementation(async (_text, agent) => {
      agent.emit("toolCall", { name: "saveProfile", input: profile(), result: {} });
      return "ok";
    });

    await runTrack3(makeCtx());

    expect(mockProfileDeleteMany).toHaveBeenCalledWith({ where: { userId: uuid(2) } });
    expect(mockProfileUpdate).not.toHaveBeenCalled();
  });
});
