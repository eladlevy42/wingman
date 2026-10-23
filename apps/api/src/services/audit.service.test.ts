import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    auditEvent: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from "@wingman/database";
import { recordEvent } from "./audit.service";
import { runWithCorrelationId } from "../middleware/correlationId";

// recordEvent must log every drop, and the tests assert it does — but the
// messages themselves are noise in the test output.
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

const MATCH_ID = "5e0e77ae-0000-4000-8000-000000000001";

function createdRow(): { type: string; payload: string; userId: string | null } {
  const call = vi.mocked(prisma.auditEvent.create).mock.calls[0]![0] as {
    data: { type: string; payload: string; userId: string | null };
  };
  return call.data;
}

describe("recordEvent", () => {
  it("writes a row when the payload matches its type's schema", async () => {
    await recordEvent("PITCH_DECIDED", { matchId: MATCH_ID, decision: "yeah" }, { userId: "u-1" });

    expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    const row = createdRow();
    expect(row.type).toBe("PITCH_DECIDED");
    expect(row.userId).toBe("u-1");
    expect(JSON.parse(row.payload)).toEqual({ matchId: MATCH_ID, decision: "yeah" });
  });

  it("assigns a non-empty correlationId even outside any request scope", async () => {
    await recordEvent("PHOTO_UPLOADED", {}, { userId: "u-1" });

    const call = vi.mocked(prisma.auditEvent.create).mock.calls[0]![0] as {
      data: { correlationId: string };
    };
    expect(call.data.correlationId).toBeTruthy();
  });

  // The privacy gate's three rejection paths (#552 AC): each drops the write
  // entirely and logs — never a partial or raw row.
  describe("dropping a payload that fails its schema", () => {
    it("drops an unknown field", async () => {
      await recordEvent(
        "PITCH_DECIDED",
        // The compile-time type forbids this; the runtime gate is the defense
        // against exactly the caller who casts around it.
        { matchId: MATCH_ID, decision: "yeah", email: "a@b.c" } as never,
        { userId: "u-1" }
      );

      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });

    it("drops a wrong-typed field", async () => {
      await recordEvent("TIMES_PROPOSED", { matchId: MATCH_ID, slotCount: "three" } as never, {
        userId: "u-1",
      });

      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });

    it("drops a payload missing a required field", async () => {
      await recordEvent("PITCH_DECIDED", { decision: "yeah" } as never, { userId: "u-1" });

      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe("never breaking the caller", () => {
    it("swallows a database error instead of propagating it", async () => {
      vi.mocked(prisma.auditEvent.create).mockRejectedValue(new Error("SQLITE_BUSY"));

      // The calling service's contract: recordEvent resolves no matter what.
      await expect(recordEvent("PHOTO_UPLOADED", {}, { userId: "u-1" })).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
    });

    it("lets a service that awaited it return normally after a failed write", async () => {
      vi.mocked(prisma.auditEvent.create).mockRejectedValue(new Error("disk full"));

      // A stand-in for any writer service: does its real work, then records.
      async function someServiceAction(): Promise<string> {
        await recordEvent("USER_REGISTERED", {}, { userId: "u-1" });
        return "done";
      }

      await expect(someServiceAction()).resolves.toBe("done");
    });
  });

  // The never-linked guarantee (docs/adr/0038): a row is about a user OR an
  // anonymous session, never both — enforced at the write path.
  describe("the userId/anonSessionId XOR", () => {
    it("writes a pre-auth event with anonSessionId and a null userId", async () => {
      await recordEvent("USER_REGISTERED", {}, { anonSessionId: "anon-1" });

      const call = vi.mocked(prisma.auditEvent.create).mock.calls[0]![0] as {
        data: { userId: string | null; anonSessionId: string | null };
      };
      expect(call.data.userId).toBeNull();
      expect(call.data.anonSessionId).toBe("anon-1");
    });

    it("drops an event claiming both a user and an anonymous session", async () => {
      await recordEvent("USER_REGISTERED", {}, { userId: "u-1", anonSessionId: "anon-1" } as never);

      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });

    it("drops an event claiming neither", async () => {
      await recordEvent("USER_REGISTERED", {}, {} as never);

      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe("correlation", () => {
    it("stamps two events recorded in the same scope with the same id", async () => {
      await runWithCorrelationId(async () => {
        await recordEvent("PHOTO_UPLOADED", {}, { userId: "u-1" });
        await recordEvent(
          "PITCH_DECIDED",
          { matchId: MATCH_ID, decision: "nah" },
          { userId: "u-1" }
        );
      });

      const calls = vi.mocked(prisma.auditEvent.create).mock.calls as unknown as [
        { data: { correlationId: string } },
      ][];
      expect(calls).toHaveLength(2);
      expect(calls[0]![0].data.correlationId).toBe(calls[1]![0].data.correlationId);
    });

    it("stamps events from different scopes with different ids", async () => {
      await runWithCorrelationId(() => recordEvent("PHOTO_UPLOADED", {}, { userId: "u-1" }));
      await runWithCorrelationId(() => recordEvent("PHOTO_UPLOADED", {}, { userId: "u-2" }));

      const calls = vi.mocked(prisma.auditEvent.create).mock.calls as unknown as [
        { data: { correlationId: string } },
      ][];
      expect(calls[0]![0].data.correlationId).not.toBe(calls[1]![0].data.correlationId);
    });
  });
});
