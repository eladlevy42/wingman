import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NotificationPayload } from "@wingman/shared";

vi.mock("@wingman/database", () => ({
  prisma: {
    notification: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // send() now dispatches push as well (#478). No device is registered in
    // these tests, so pushService short-circuits before any network call —
    // which is also what makes `onUnhandledRequest: "error"` safe to keep.
    pushToken: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

import { prisma } from "@wingman/database";
import { notificationService } from "./notification.service";

const received: NotificationPayload[] = [];

const server = setupServer(
  http.post("http://localhost:5173/mock/notify", async ({ request }) => {
    const body = (await request.json()) as NotificationPayload;
    received.push(body);
    return HttpResponse.json({ ok: true });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  received.length = 0;
  server.resetHandlers();
  vi.mocked(prisma.notification.create).mockClear();
  vi.mocked(prisma.notification.create).mockResolvedValue({} as never);
  vi.mocked(prisma.notification.findMany).mockClear();
  vi.mocked(prisma.notification.findMany).mockResolvedValue([]);
});
afterAll(() => server.close());

describe("notificationService", () => {
  it("send completes without error", async () => {
    await expect(
      notificationService.send("user-1", "MATCH_FOUND", { matchId: "m-1" })
    ).resolves.toBeUndefined();
  });

  it("POSTs the correct userId and type", async () => {
    await notificationService.send("user-2", "CHECKIN_PROMPT", {});
    expect(received).toHaveLength(1);
    expect(received[0].userId).toBe("user-2");
    expect(received[0].type).toBe("CHECKIN_PROMPT");
  });

  it("POSTs the payload untouched", async () => {
    await notificationService.send("user-3", "PRE_DATE_REMINDER", {
      matchId: "m-3",
      date: "2026-07-01",
    });
    expect(received[0].payload).toEqual({ matchId: "m-3", date: "2026-07-01" });
  });

  it("sends all five notification types without error", async () => {
    const types = [
      "MATCH_FOUND",
      "DATE_ASSIGNED",
      "PRE_DATE_REMINDER",
      "DEBRIEF_NUDGE",
      "CHECKIN_PROMPT",
    ] as const;
    for (const type of types) {
      await expect(notificationService.send("user-4", type, {})).resolves.toBeUndefined();
    }
    expect(received).toHaveLength(5);
  });

  it("does not reject when the endpoint is unreachable — the caller's flow must not see the failure", async () => {
    server.use(http.post("http://localhost:5173/mock/notify", () => HttpResponse.error()));

    await expect(
      notificationService.send("user-5", "MATCH_FOUND", { matchId: "m-5" })
    ).resolves.toBeUndefined();
  });

  it("logs the failure with the notification's type and userId so it stays diagnosable", async () => {
    server.use(http.post("http://localhost:5173/mock/notify", () => HttpResponse.error()));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await notificationService.send("user-6", "DEBRIEF_NUDGE", {});

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("DEBRIEF_NUDGE"),
      expect.anything()
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("user-6"), expect.anything());
    warnSpy.mockRestore();
  });

  it("logs an HTTP-level failure (e.g. wrong NOTIFY_URL route) instead of treating it as delivered", async () => {
    server.use(
      http.post("http://localhost:5173/mock/notify", () => HttpResponse.json({}, { status: 404 }))
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      notificationService.send("user-8", "MATCH_FOUND", { matchId: "m-8" })
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("MATCH_FOUND"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("user-8"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("404"));
    warnSpy.mockRestore();
  });

  // #357: the persisted row is the REAL delivery channel — the web app polls
  // it; the POST above only ever reached MSW test pages.
  it("persists the notification row before posting", async () => {
    await notificationService.send("user-9", "MATCH_FOUND", { matchId: "m-9" });

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { userId: "user-9", type: "MATCH_FOUND", payload: JSON.stringify({ matchId: "m-9" }) },
    });
  });

  it("still resolves (and still posts) when persistence fails", async () => {
    vi.mocked(prisma.notification.create).mockRejectedValueOnce(new Error("db locked"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notificationService.send("user-10", "DEBRIEF_NUDGE", {})).resolves.toBeUndefined();

    expect(received).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("persist"), expect.anything());
    warnSpy.mockRestore();
  });

  it("listNotifications maps rows oldest-first and parses payloads", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      {
        id: "123e4567-e89b-12d3-a456-426614174101",
        userId: "123e4567-e89b-12d3-a456-426614174000",
        type: "MATCH_FOUND",
        payload: JSON.stringify({ matchId: "m-1" }),
        createdAt: new Date("2026-07-15T10:00:00.000Z"),
      },
    ] as never);

    const result = await notificationService.listNotifications(
      "123e4567-e89b-12d3-a456-426614174000"
    );

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: "123e4567-e89b-12d3-a456-426614174000" },
      orderBy: { createdAt: "asc" },
    });
    expect(result.notifications).toEqual([
      {
        id: "123e4567-e89b-12d3-a456-426614174101",
        userId: "123e4567-e89b-12d3-a456-426614174000",
        type: "MATCH_FOUND",
        payload: { matchId: "m-1" },
        createdAt: "2026-07-15T10:00:00.000Z",
      },
    ]);
  });

  it("listNotifications passes the since cursor and skips malformed rows", async () => {
    const since = new Date("2026-07-15T09:00:00.000Z");
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      {
        id: "123e4567-e89b-12d3-a456-426614174102",
        userId: "123e4567-e89b-12d3-a456-426614174000",
        type: "DEBRIEF_NUDGE",
        payload: "{not json",
        createdAt: new Date("2026-07-15T10:00:00.000Z"),
      },
      {
        id: "123e4567-e89b-12d3-a456-426614174103",
        userId: "123e4567-e89b-12d3-a456-426614174000",
        type: "CHECKIN_PROMPT",
        payload: "{}",
        createdAt: new Date("2026-07-15T11:00:00.000Z"),
      },
    ] as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await notificationService.listNotifications(
      "123e4567-e89b-12d3-a456-426614174000",
      since
    );

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: "123e4567-e89b-12d3-a456-426614174000", createdAt: { gt: since } },
      orderBy: { createdAt: "asc" },
    });
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].type).toBe("CHECKIN_PROMPT");
    warnSpy.mockRestore();
  });

  it("skips a row with a type outside the enum instead of failing the whole poll", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      {
        id: "123e4567-e89b-12d3-a456-426614174104",
        userId: "123e4567-e89b-12d3-a456-426614174000",
        type: "NOT_A_REAL_TYPE",
        payload: "{}",
        createdAt: new Date("2026-07-15T10:00:00.000Z"),
      },
      {
        id: "123e4567-e89b-12d3-a456-426614174105",
        userId: "123e4567-e89b-12d3-a456-426614174000",
        type: "CHECKIN_PROMPT",
        payload: "{}",
        createdAt: new Date("2026-07-15T11:00:00.000Z"),
      },
    ] as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await notificationService.listNotifications(
      "123e4567-e89b-12d3-a456-426614174000"
    );

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].type).toBe("CHECKIN_PROMPT");
    warnSpy.mockRestore();
  });

  it("abandons a hanging endpoint instead of stalling the caller's flow forever", async () => {
    // The endpoint never responds; without the timeout this would hang the
    // test (and, in production, the orchestration/follow-up sweep) forever.
    server.use(
      http.post("http://localhost:5173/mock/notify", async () => {
        await delay("infinite");
        return HttpResponse.json({ ok: true });
      })
    );
    // Simulate the timeout firing without waiting out the real 5s duration:
    // hand fetch an AbortSignal this test controls directly.
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);

    const sendPromise = notificationService.send("user-7", "MATCH_FOUND", {});
    controller.abort();

    await expect(sendPromise).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
