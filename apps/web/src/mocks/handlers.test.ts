import { http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { notifyResolver, pingResolver } from "./handlers";
import { clearNotifications, getNotifications } from "@wingman/shared";

// In Node (Vitest) context MSW requires absolute URLs; browser handlers use relative "/mock/notify"
const server = setupServer(
  http.post("http://localhost/mock/notify", notifyResolver),
  http.get("http://localhost/mock/ping", pingResolver)
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  clearNotifications();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("MSW /mock/notify handler", () => {
  it("stores a received notification in the client store", async () => {
    await fetch("http://localhost/mock/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-1",
        type: "MATCH_FOUND",
        payload: { matchId: "m-1" },
      }),
    });

    const notifications = getNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe("user-1");
    expect(notifications[0].type).toBe("MATCH_FOUND");
    expect(notifications[0].payload).toEqual({ matchId: "m-1" });
    expect(notifications[0].id).toBeDefined();
    expect(notifications[0].receivedAt).toBeInstanceOf(Date);
  });

  it("returns { ok: true } with status 200", async () => {
    const res = await fetch("http://localhost/mock/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-2",
        type: "CHECKIN_PROMPT",
        payload: {},
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("store is isolated between tests — starts empty", () => {
    expect(getNotifications()).toHaveLength(0);
  });

  it("accumulates multiple notifications in the store", async () => {
    const types = [
      "MATCH_FOUND",
      "DATE_ASSIGNED",
      "PRE_DATE_REMINDER",
      "DEBRIEF_NUDGE",
      "CHECKIN_PROMPT",
    ] as const;
    for (const type of types) {
      await fetch("http://localhost/mock/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-3", type, payload: {} }),
      });
    }
    expect(getNotifications()).toHaveLength(5);
  });
});

describe("MSW /mock/ping handler", () => {
  it("returns { ok: true } without touching the notification store", async () => {
    const res = await fetch("http://localhost/mock/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getNotifications()).toHaveLength(0);
  });
});
