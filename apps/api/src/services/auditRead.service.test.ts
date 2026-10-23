import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    auditEvent: { findMany: vi.fn() },
    agentCall: { findMany: vi.fn() },
    auditRollup: { findMany: vi.fn() },
  },
}));

import { prisma } from "@wingman/database";
import { AuditTimelineResponseSchema, AgentCostResponseSchema } from "@wingman/shared";
import { getAgentCosts, getUserTimeline } from "./auditRead.service";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.agentCall.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.auditRollup.findMany).mockResolvedValue([] as never);
});

const at = (iso: string) => new Date(iso);

function call(overrides: Record<string, unknown> = {}) {
  return {
    id: "call-1",
    correlationId: "corr-1",
    userId: "u-1",
    actor: "barney",
    purpose: "interview_turn",
    model: "haiku",
    costUsd: 0.01,
    durationMs: 900,
    toolNames: '["saveProfile"]',
    retryCount: 0,
    outcome: "ok",
    errorMessage: null,
    createdAt: at("2026-03-01T10:00:01Z"),
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    type: "INTERVIEW_TURN",
    userId: "u-1",
    anonSessionId: null,
    correlationId: "corr-1",
    payload: '{"mode":"interview_self","latencyMs":1200}',
    createdAt: at("2026-03-01T10:00:00Z"),
    ...overrides,
  };
}

describe("getUserTimeline", () => {
  // The join the whole correlationId design exists for (docs/adr/0038).
  it("hangs each event's agent calls off it by correlationId", async () => {
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([event()] as never);
    vi.mocked(prisma.agentCall.findMany).mockResolvedValue([call()] as never);

    const result = await getUserTimeline("u-1");

    expect(AuditTimelineResponseSchema.safeParse(result).success).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.payload).toEqual({ mode: "interview_self", latencyMs: 1200 });
    expect(result.entries[0]!.agentCalls.map((c) => c.id)).toEqual(["call-1"]);
    expect(result.entries[0]!.agentCalls[0]!.toolNames).toEqual(["saveProfile"]);
  });

  // Two events in one request share the id, and attaching the calls to both
  // would double the spend the page shows.
  it("attaches a shared correlation's calls once, not to every event on it", async () => {
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([
      event({ id: "event-2", createdAt: at("2026-03-01T10:00:02Z") }),
      event({ id: "event-1" }),
    ] as never);
    vi.mocked(prisma.agentCall.findMany).mockResolvedValue([call()] as never);

    const result = await getUserTimeline("u-1");

    const attached = result.entries.flatMap((entry) => entry.agentCalls);
    expect(attached).toHaveLength(1);
  });

  // A sweep's negotiation calls are caused by the clock, not by the user.
  // Dropping them would make the page's spend disagree with the table.
  it("reports calls with no matching event separately rather than dropping them", async () => {
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([event()] as never);
    vi.mocked(prisma.agentCall.findMany).mockResolvedValue([
      call(),
      call({ id: "call-2", correlationId: "sweep-corr", actor: "negotiation" }),
    ] as never);

    const result = await getUserTimeline("u-1");

    expect(result.entries[0]!.agentCalls.map((c) => c.id)).toEqual(["call-1"]);
    expect(result.unattributedCalls.map((c) => c.id)).toEqual(["call-2"]);
  });

  it("survives a corrupt payload or toolNames rather than failing the page", async () => {
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([
      event({ payload: "not json at all" }),
    ] as never);
    vi.mocked(prisma.agentCall.findMany).mockResolvedValue([
      call({ toolNames: "{not an array}" }),
    ] as never);

    const result = await getUserTimeline("u-1");

    expect(result.entries[0]!.payload).toEqual({});
    expect(result.entries[0]!.agentCalls[0]!.toolNames).toEqual([]);
  });

  it("returns an empty timeline for a user with no rows", async () => {
    const result = await getUserTimeline("nobody");

    expect(result.entries).toEqual([]);
    expect(result.unattributedCalls).toEqual([]);
  });
});

describe("getAgentCosts", () => {
  it("groups by day, actor and model, and totals reconcile with the rows", async () => {
    vi.mocked(prisma.agentCall.findMany).mockResolvedValue([
      {
        actor: "barney",
        model: "haiku",
        costUsd: 0.01,
        durationMs: 100,
        createdAt: at("2026-03-01T01:00:00Z"),
      },
      {
        actor: "barney",
        model: "haiku",
        costUsd: 0.02,
        durationMs: 200,
        createdAt: at("2026-03-01T02:00:00Z"),
      },
      {
        actor: "negotiation",
        model: "sonnet",
        costUsd: 0.5,
        durationMs: 900,
        createdAt: at("2026-03-02T02:00:00Z"),
      },
    ] as never);

    const result = await getAgentCosts(at("2026-03-01T00:00:00Z"), at("2026-03-03T00:00:00Z"));

    expect(AgentCostResponseSchema.safeParse(result).success).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((r) => r.day === "2026-03-01")).toMatchObject({
      actor: "barney",
      calls: 2,
      costUsd: 0.03,
      durationMs: 300,
    });
    // The reconciliation the AC asks for: the header total is the sum of what
    // the table shows, not a separately-derived number.
    expect(result.totalCostUsd).toBeCloseTo(0.53, 10);
    expect(result.totalCostUsd).toBeCloseTo(
      result.rows.reduce((sum, row) => sum + row.costUsd, 0),
      10
    );
    expect(result.totalCalls).toBe(3);
    expect(result.includesRolledUpDays).toBe(false);
  });

  it("falls back to the rollup for a day whose raw rows have been swept", async () => {
    vi.mocked(prisma.auditRollup.findMany).mockResolvedValue([
      {
        day: "2026-01-05",
        kind: "agent_call",
        actor: "barney",
        model: "haiku",
        count: 40,
        costUsd: 1.25,
        durationMs: 40_000,
      },
    ] as never);

    const result = await getAgentCosts(at("2026-01-01T00:00:00Z"), at("2026-03-03T00:00:00Z"));

    expect(result.rows).toEqual([
      {
        day: "2026-01-05",
        actor: "barney",
        model: "haiku",
        calls: 40,
        costUsd: 1.25,
        durationMs: 40_000,
      },
    ]);
    expect(result.totalCostUsd).toBe(1.25);
    // The page has to be able to say so: "no calls that day" and "that day was
    // swept" are different facts.
    expect(result.includesRolledUpDays).toBe(true);
  });

  // A day inside the retention window still has raw rows, and its rollup can
  // lag behind writes that landed after the last sweep — so raw wins.
  it("prefers raw rows over the rollup for a day that still has both", async () => {
    vi.mocked(prisma.agentCall.findMany).mockResolvedValue([
      {
        actor: "barney",
        model: "haiku",
        costUsd: 0.05,
        durationMs: 100,
        createdAt: at("2026-03-01T01:00:00Z"),
      },
    ] as never);
    vi.mocked(prisma.auditRollup.findMany).mockResolvedValue([
      {
        day: "2026-03-01",
        kind: "agent_call",
        actor: "barney",
        model: "haiku",
        count: 1,
        costUsd: 0.01,
        durationMs: 100,
      },
    ] as never);

    const result = await getAgentCosts(at("2026-03-01T00:00:00Z"), at("2026-03-03T00:00:00Z"));

    expect(result.totalCostUsd).toBe(0.05);
    expect(result.includesRolledUpDays).toBe(false);
  });

  it("reports an empty range without claiming anything was deleted", async () => {
    const result = await getAgentCosts(at("2026-03-01T00:00:00Z"), at("2026-03-03T00:00:00Z"));

    expect(result.rows).toEqual([]);
    expect(result.totalCostUsd).toBe(0);
    expect(result.includesRolledUpDays).toBe(false);
  });
});
