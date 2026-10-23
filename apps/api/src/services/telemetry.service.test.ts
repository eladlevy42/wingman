import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: { auditEvent: { create: vi.fn() } },
}));

import { prisma } from "@wingman/database";
import { recordTelemetryBatch } from "./telemetry.service";

let consoleWarn: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
  consoleError.mockRestore();
});

function writtenRows(): { type: string; userId: string | null; anonSessionId: string | null }[] {
  return vi
    .mocked(prisma.auditEvent.create)
    .mock.calls.map(
      (call) =>
        (call[0] as { data: { type: string; userId: string | null; anonSessionId: string | null } })
          .data
    );
}

const screenView = {
  type: "SCREEN_VIEWED",
  payload: { screen: "register", client: "web" },
};

describe("recordTelemetryBatch", () => {
  it("writes one AuditEvent per valid entry", async () => {
    const result = await recordTelemetryBatch({
      anonSessionId: "anon-1",
      events: [screenView, screenView],
    });

    expect(result).toEqual({ accepted: 2, dropped: 0 });
    expect(writtenRows()).toHaveLength(2);
  });

  it("carries anonSessionId with a null userId for a pre-auth batch", async () => {
    await recordTelemetryBatch({ anonSessionId: "anon-1", events: [screenView] });

    const row = writtenRows()[0]!;
    expect(row.anonSessionId).toBe("anon-1");
    expect(row.userId).toBeNull();
  });

  it("carries userId with a null anonSessionId for a signed-in batch", async () => {
    await recordTelemetryBatch({ userId: "u-1", events: [screenView] });

    const row = writtenRows()[0]!;
    expect(row.userId).toBe("u-1");
    expect(row.anonSessionId).toBeNull();
  });

  it("drops the invalid entries of a mixed batch and writes the rest", async () => {
    const result = await recordTelemetryBatch({
      anonSessionId: "anon-1",
      events: [
        screenView,
        // Unknown type.
        { type: "MADE_UP_EVENT", payload: {} },
        // Known type, payload fails its schema.
        { type: "SCREEN_VIEWED", payload: { screen: "not-a-screen", client: "web" } },
        {
          type: "CTA_TAPPED",
          payload: { screen: "login", action: "login_submitted", client: "mobile" },
        },
      ],
    });

    expect(result).toEqual({ accepted: 2, dropped: 2 });
    expect(writtenRows().map((row) => row.type)).toEqual(["SCREEN_VIEWED", "CTA_TAPPED"]);
  });

  // The gate that matters most: /api/telemetry takes whatever a client sends,
  // so a client claiming a server-owned event is forging history.
  it.each(["USER_REGISTERED", "MATCHING_STATE_CHANGED", "PITCH_DECIDED", "INTERVIEW_TURN"])(
    "refuses %s even with a payload that would otherwise be valid",
    async (type) => {
      const result = await recordTelemetryBatch({
        anonSessionId: "anon-1",
        events: [
          {
            type,
            payload: {
              from: "IDLE",
              to: "MATCHED",
              trigger: "negotiation_matched",
              mode: "interview_self",
              matchId: "5e0e77ae-0000-4000-8000-000000000001",
              decision: "yeah",
            },
          },
        ],
      });

      expect(result).toEqual({ accepted: 0, dropped: 1 });
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    }
  );

  it("drops a client event whose payload smuggles an extra field", async () => {
    const result = await recordTelemetryBatch({
      anonSessionId: "anon-1",
      events: [
        {
          type: "SCREEN_VIEWED",
          payload: { screen: "register", client: "web", email: "someone@example.com" },
        },
      ],
    });

    expect(result).toEqual({ accepted: 0, dropped: 1 });
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it("does not fail the batch when a write rejects", async () => {
    vi.mocked(prisma.auditEvent.create).mockRejectedValueOnce(new Error("database is locked"));

    const result = await recordTelemetryBatch({
      anonSessionId: "anon-1",
      events: [screenView, screenView],
    });

    // recordEvent swallows its own failure, so the entry still counts as
    // accepted — telemetry is never allowed to fail the request it describes.
    expect(result.accepted).toBe(2);
  });
});
