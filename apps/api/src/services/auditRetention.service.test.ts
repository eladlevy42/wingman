import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    auditEvent: { findMany: vi.fn(), deleteMany: vi.fn() },
    agentCall: { findMany: vi.fn(), deleteMany: vi.fn() },
    auditRollup: { upsert: vi.fn() },
  },
}));
vi.mock("./orchestration.service", () => ({ isOrchestrationRunning: vi.fn(() => false) }));

import { prisma } from "@wingman/database";
import { isOrchestrationRunning } from "./orchestration.service";
import {
  cutoffFor,
  dayKey,
  deleteAuditDataForUser,
  deleteOlderThan,
  retentionDays,
  rollUpThrough,
  runRetentionTick,
  sweepIntervalMs,
  DEFAULT_RETENTION_DAYS,
} from "./auditRetention.service";

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.agentCall.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.auditEvent.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.agentCall.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(isOrchestrationRunning).mockReturnValue(false);
});

afterEach(() => {
  delete process.env.AUDIT_RETENTION_DAYS;
  delete process.env.AUDIT_SWEEP_INTERVAL_MINUTES;
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

const at = (iso: string) => new Date(iso);

describe("dayKey and cutoffFor", () => {
  it("buckets by UTC day", () => {
    expect(dayKey(at("2026-03-04T23:59:59.000Z"))).toBe("2026-03-04");
    expect(dayKey(at("2026-03-05T00:00:00.000Z"))).toBe("2026-03-05");
  });

  it("puts the cutoff at midnight UTC, N days back", () => {
    expect(cutoffFor(at("2026-06-10T13:45:00.000Z"), 90).toISOString()).toBe(
      "2026-03-12T00:00:00.000Z"
    );
  });
});

describe("configuration", () => {
  it("defaults sanely", () => {
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    expect(sweepIntervalMs()).toBe(24 * 60 * 60_000);
  });

  it("reads a valid override", () => {
    process.env.AUDIT_RETENTION_DAYS = "30";
    process.env.AUDIT_SWEEP_INTERVAL_MINUTES = "60";
    expect(retentionDays()).toBe(30);
    expect(sweepIntervalMs()).toBe(60 * 60_000);
  });

  // The #381 precedent: a malformed value falls back rather than throwing at
  // startup, so a typo cannot stop the API from booting.
  it.each(["nonsense", "-1", "0"])("falls back on %s rather than throwing", (raw) => {
    process.env.AUDIT_RETENTION_DAYS = raw;
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });
});

describe("rollUpThrough", () => {
  it("counts events per type per day", async () => {
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([
      { type: "USER_REGISTERED", createdAt: at("2026-03-01T10:00:00Z") },
      { type: "USER_REGISTERED", createdAt: at("2026-03-01T18:00:00Z") },
      { type: "PITCH_DECIDED", createdAt: at("2026-03-02T09:00:00Z") },
    ] as never);

    const result = await rollUpThrough(at("2026-03-03T00:00:00Z"));

    expect(result.days).toBe(2);
    const written = vi.mocked(prisma.auditRollup.upsert).mock.calls.map((call) => call[0].create);
    expect(written).toContainEqual(
      expect.objectContaining({ day: "2026-03-01", eventType: "USER_REGISTERED", count: 2 })
    );
    expect(written).toContainEqual(
      expect.objectContaining({ day: "2026-03-02", eventType: "PITCH_DECIDED", count: 1 })
    );
  });

  it("sums agent calls and their spend per actor and model", async () => {
    vi.mocked(prisma.agentCall.findMany).mockResolvedValue([
      {
        actor: "barney",
        model: "haiku",
        costUsd: 0.01,
        durationMs: 100,
        createdAt: at("2026-03-01T10:00:00Z"),
      },
      {
        actor: "barney",
        model: "haiku",
        costUsd: 0.02,
        durationMs: 200,
        createdAt: at("2026-03-01T11:00:00Z"),
      },
      {
        actor: "negotiation",
        model: "sonnet",
        costUsd: 0.5,
        durationMs: 900,
        createdAt: at("2026-03-01T12:00:00Z"),
      },
    ] as never);

    await rollUpThrough(at("2026-03-03T00:00:00Z"));

    const written = vi.mocked(prisma.auditRollup.upsert).mock.calls.map((call) => call[0].create);
    expect(written).toContainEqual(
      expect.objectContaining({
        day: "2026-03-01",
        actor: "barney",
        model: "haiku",
        count: 2,
        costUsd: 0.03,
        durationMs: 300,
      })
    );
    expect(written).toContainEqual(
      expect.objectContaining({ actor: "negotiation", model: "sonnet", count: 1, costUsd: 0.5 })
    );
  });

  // The sweep runs on a timer with no memory of what it already did, and a
  // restart can land mid-sweep — so re-running a day must not double it.
  it("writes with upsert, so re-running a day recomputes rather than accumulates", async () => {
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([
      { type: "USER_REGISTERED", createdAt: at("2026-03-01T10:00:00Z") },
    ] as never);

    await rollUpThrough(at("2026-03-03T00:00:00Z"));
    await rollUpThrough(at("2026-03-03T00:00:00Z"));

    const calls = vi.mocked(prisma.auditRollup.upsert).mock.calls;
    expect(calls).toHaveLength(2);
    // Same identity both times, and the update carries the recomputed count —
    // not an increment.
    expect(calls[0]![0].where).toEqual(calls[1]![0].where);
    expect(calls[1]![0].update).toEqual(expect.objectContaining({ count: 1 }));
  });
});

describe("deleteOlderThan", () => {
  it("deletes strictly before the cutoff, in one statement per table", async () => {
    vi.mocked(prisma.auditEvent.deleteMany).mockResolvedValue({ count: 4 } as never);
    vi.mocked(prisma.agentCall.deleteMany).mockResolvedValue({ count: 7 } as never);
    const cutoff = at("2026-03-12T00:00:00Z");

    const result = await deleteOlderThan(cutoff);

    expect(result).toEqual({ events: 4, calls: 7 });
    expect(prisma.auditEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditEvent.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    });
    expect(prisma.agentCall.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("deleteAuditDataForUser", () => {
  it("erases one person in one statement per table, scoped to them", async () => {
    vi.mocked(prisma.auditEvent.deleteMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.agentCall.deleteMany).mockResolvedValue({ count: 5 } as never);

    const result = await deleteAuditDataForUser("u-1");

    expect(result).toEqual({ events: 3, calls: 5 });
    expect(prisma.auditEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.agentCall.deleteMany).toHaveBeenCalledTimes(1);
    // Scoped by userId and nothing else: everyone else's rows are untouched.
    expect(prisma.auditEvent.deleteMany).toHaveBeenCalledWith({ where: { userId: "u-1" } });
    expect(prisma.agentCall.deleteMany).toHaveBeenCalledWith({ where: { userId: "u-1" } });
  });
});

describe("runRetentionTick", () => {
  // The ordering the whole design rests on: reversed, the deletion takes the
  // month-over-month statistics with it.
  it("rolls up before it deletes", async () => {
    const order: string[] = [];
    vi.mocked(prisma.auditRollup.upsert).mockImplementation((async () => {
      order.push("rollup");
    }) as never);
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([
      { type: "USER_REGISTERED", createdAt: at("2026-03-01T10:00:00Z") },
    ] as never);
    vi.mocked(prisma.auditEvent.deleteMany).mockImplementation((async () => {
      order.push("delete");
      return { count: 0 };
    }) as never);

    await runRetentionTick(at("2026-06-10T00:00:00Z"));

    expect(order).toEqual(["rollup", "delete"]);
  });

  // SQLite has one writer, and the matching sweep is the process doing the
  // actual work — a daily cleanup is never worth making it wait.
  it("skips its tick while a match cycle holds the orchestration lock", async () => {
    vi.mocked(isOrchestrationRunning).mockReturnValue(true);

    const result = await runRetentionTick(at("2026-06-10T00:00:00Z"));

    expect(result).toEqual({ skipped: "orchestration_running" });
    expect(prisma.auditEvent.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditRollup.upsert).not.toHaveBeenCalled();
  });

  it("deletes using the configured retention window", async () => {
    process.env.AUDIT_RETENTION_DAYS = "30";

    await runRetentionTick(at("2026-06-10T12:00:00Z"));

    expect(prisma.auditEvent.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: at("2026-05-11T00:00:00Z") } },
    });
  });

  it("never lets a failed sweep escape into the process", async () => {
    vi.mocked(prisma.auditEvent.findMany).mockRejectedValue(new Error("database is locked"));

    await expect(runRetentionTick(at("2026-06-10T00:00:00Z"))).resolves.toEqual({});
    expect(consoleError).toHaveBeenCalled();
  });

  it("does not overlap itself", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(prisma.auditEvent.findMany).mockImplementation((async () => {
      await gate;
      return [];
    }) as never);

    const first = runRetentionTick(at("2026-06-10T00:00:00Z"));
    const second = await runRetentionTick(at("2026-06-10T00:00:00Z"));

    expect(second).toEqual({ skipped: "already_running" });
    release();
    await first;
  });
});
