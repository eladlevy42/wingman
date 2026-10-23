// Shared fakes, mocks, and fixtures for the barney.service split's test files
// (barney.session.service.test.ts, barney.message.service.test.ts,
// barney.sessionRegistry.test.ts). Every split still tests the public
// barrel (./barney.service), so all three files share the same doubles for
// the agent/engine drivers and their upstream dependencies.
//
// Import this module FIRST in each test file, before importing "./barney.service"
// — Vitest hoists this file's vi.mock() calls to its own top, and they only
// intercept imports of the real modules that happen after this file loads.
import { vi } from "vitest";

export interface ToolCall {
  name: string;
}

export type ToolCallListener = (event: { name: string }) => void;

export interface FakeAgentInstance {
  mode: string;
  userId: string;
  context?: Record<string, string>;
  reply: string;
  toolCalls: ToolCall[];
  on(event: "toolCall", listener: ToolCallListener): void;
  off(event: "toolCall", listener: ToolCallListener): void;
  sendMessage: ReturnType<typeof vi.fn>;
}

export interface SoftTurnFn {
  (...args: unknown[]): Promise<{
    sufficient: boolean;
    extracted_value: unknown;
    message: string;
  }>;
}

export interface FakeEngineInstance {
  userId: string;
  result: { reply: string; phaseComplete: boolean };
  runSoftTurn?: SoftTurnFn;
  // The language the session was constructed with, and every setLanguage() the
  // message service applied to it (ADR-0037).
  language?: string;
  setLanguage: ReturnType<typeof vi.fn>;
  getLanguage: ReturnType<typeof vi.fn>;
  // What the language toggle restates; set it to a turn to have one to restate.
  restated: { reply: string; phaseComplete: boolean; question?: string } | null;
  restatePending: ReturnType<typeof vi.fn>;
  handleMessage: ReturnType<typeof vi.fn>;
  // The per-turn durable snapshot pair (#545).
  snapshot: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
}

export interface FakeWarmInstance {
  softTurn: SoftTurnFn;
  prewarm: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

// Fakes for both session drivers. The agent fake replays a queued tool-call
// script (to drive phaseComplete); the engine fake just returns a canned turn
// result. Hand-rolled on/off/emit stands in for EventEmitter so the factory
// needs no imports — vi.hoisted runs before ES imports initialize. Keeps the
// service tests free of the Anthropic SDK.
const {
  agentInstances,
  engineInstances,
  warmInstances,
  FakeAgent,
  FakeEngine,
  createWarmSoftTurn,
} = vi.hoisted(() => {
  const agentsCreated: FakeAgentInstance[] = [];
  const enginesCreated: FakeEngineInstance[] = [];
  const warmsCreated: FakeWarmInstance[] = [];

  // Stand-in for the warm soft-turn runner. Records each instance and its
  // prewarm/close spies so tests can assert createSession wires and eagerly
  // spawns one per engine session — without spawning a real subprocess.
  const createWarmSoftTurn = vi.fn(() => {
    const warm: FakeWarmInstance = {
      softTurn: (async () => ({
        sufficient: true,
        extracted_value: null,
        message: "warm",
      })) as SoftTurnFn,
      prewarm: vi.fn(),
      close: vi.fn(),
    };
    warmsCreated.push(warm);
    return warm;
  });

  class FakeAgentImpl {
    reply = "default reply";
    toolCalls: ToolCall[] = [];
    private listeners: ToolCallListener[] = [];

    constructor(
      public mode: string,
      public userId: string,
      public context?: Record<string, string>
    ) {
      agentsCreated.push(this);
    }

    on(event: "toolCall", listener: ToolCallListener): void {
      if (event === "toolCall") this.listeners.push(listener);
    }

    off(event: "toolCall", listener: ToolCallListener): void {
      if (event === "toolCall") this.listeners = this.listeners.filter((l) => l !== listener);
    }

    sendMessage = vi.fn(async (): Promise<string> => {
      for (const call of this.toolCalls) {
        for (const listener of this.listeners) {
          listener({ name: call.name });
        }
      }
      return this.reply;
    });
  }

  class FakeEngineImpl {
    result = { reply: "engine reply", phaseComplete: false };
    runSoftTurn?: SoftTurnFn;

    language?: string;

    constructor(
      public userId: string,
      deps?: { runSoftTurn?: SoftTurnFn; language?: string }
    ) {
      this.runSoftTurn = deps?.runSoftTurn;
      this.language = deps?.language;
      enginesCreated.push(this);
    }

    setLanguage = vi.fn((language: string) => {
      this.language = language;
    });

    // Mirrors the real engine's Hebrew default when constructed without one.
    getLanguage = vi.fn(() => this.language ?? "he");

    restated: { reply: string; phaseComplete: boolean; question?: string } | null = null;

    restatePending = vi.fn(() => this.restated);

    handleMessage = vi.fn(async () => this.result);

    // The per-turn durable snapshot (#545). A canned marker object is enough:
    // the message service treats the snapshot as opaque, so tests only assert
    // it was captured and stored, not what is in it.
    snapshot = vi.fn(() => ({ fake: "snapshot", userId: this.userId }));

    restore = vi.fn();
  }

  return {
    agentInstances: agentsCreated,
    engineInstances: enginesCreated,
    warmInstances: warmsCreated,
    FakeAgent: FakeAgentImpl,
    FakeEngine: FakeEngineImpl,
    createWarmSoftTurn,
  };
});

export { agentInstances, engineInstances, warmInstances, createWarmSoftTurn };

vi.mock("../agents/barney.agent", () => ({
  BarneyAgent: FakeAgent,
}));

vi.mock("../agents/interview/interview.engine", () => ({
  InterviewEngine: FakeEngine,
}));

// Mock the warm soft-turn runner: createSession creates one per engine session
// and eagerly prewarm()s it, which would otherwise spawn a real Agent SDK
// subprocess. The mock records instances + prewarm/close spies instead.
vi.mock("../agents/interview/softTurn", () => ({
  createWarmSoftTurn,
}));

// The matching-cycle trigger is an external side-effect; mock it so tests can
// assert it fires exactly when Phase 2 completes.
vi.mock("./orchestration.service", () => ({
  triggerFirstMatchCycle: vi.fn().mockResolvedValue(undefined),
}));

// Pitch/debrief sessions look up the match by id; mock it so tests control
// what comes back without touching the database.
vi.mock("./match.service", () => ({
  getMatchById: vi.fn(),
  MatchNotFoundError: class MatchNotFoundError extends Error {},
  MatchOwnershipError: class MatchOwnershipError extends Error {},
}));

// Debrief sessions look up the partner's name for DATE_CONTEXT, and the
// interview-snapshot service (#545) reads/writes InterviewSessionSnapshot rows
// after every engine turn and on rehydration.
vi.mock("@wingman/database", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    interviewSessionSnapshot: {
      upsert: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

// The language toggle records an audit event; mock the writer so tests assert
// the event without an AuditEvent table in the database mock.
vi.mock("./audit.service", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
}));

// Debrief completion (saveFeedback firing) advances the FollowUp row; mock it
// so tests assert it fires exactly when phaseComplete is true.
vi.mock("./followup.service", () => ({
  markDebriefed: vi.fn().mockResolvedValue(undefined),
}));

// A valid match for "user-1" — the default stand-in for tests that create a
// pitch or debrief session but aren't specifically exercising match
// lookup/validation. Includes venue/dateTime so debrief mode's own
// requirements are satisfied by default too.
export function makeMatch(
  overrides: Partial<{
    id: string;
    userAId: string;
    userBId: string;
    rationale: string | null;
    venue: string | null;
    dateTime: Date | null;
  }> = {}
) {
  return {
    id: "match-1",
    userAId: "user-1",
    userBId: "user-2",
    rationale: "You both love hiking and terrible puns.",
    venue: "Aroma Coffee",
    dateTime: new Date("2026-06-07T20:00:00Z"),
    ...overrides,
  };
}

// A minimal valid UserProfile for the matched partner, used by pitch mode to
// build the {{MATCH_PROFILE}} summary Barney answers questions from.
export const PARTNER_PROFILE = {
  age: 29,
  city: "Tel Aviv",
  country: "Israel",
  height: null,
  job: "Pastry chef",
  hometown: null,
  conflict_style: null,
  emotional_openness: null,
  treatment_of_others: null,
  wants_kids: true,
  kids_timeline: null,
  faith: null,
  current_motivation: null,
  life_vision: null,
  hobbies: [{ name: "cooking with friends", centrality: "high", solo_or_social: "social" }],
  typical_weekend: null,
  social_energy: null,
  social_circle: null,
};
