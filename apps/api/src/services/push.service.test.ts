import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./pushToken.service", () => ({
  pushTokenService: {
    listForUser: vi.fn(),
    prune: vi.fn().mockResolvedValue(0),
  },
}));

import { pushTokenService } from "./pushToken.service";
import { pushService } from "./push.service";

const EXPO_URL = "https://exp.host/--/api/v2/push/send";

interface SentMessage {
  to: string;
  title: string;
  body: string;
  data: { type: string; matchId?: string };
}

let batches: SentMessage[][] = [];
// Typed as Response rather than HttpResponse: MSW's HttpResponse is generic in
// its body type, and every handler here returns a differently shaped one.
let respond: () => Response = () => HttpResponse.json({ data: [{ status: "ok", id: "1" }] });

const server = setupServer(
  http.post(EXPO_URL, async ({ request }) => {
    batches.push((await request.json()) as SentMessage[]);
    return respond();
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  batches = [];
  respond = () => HttpResponse.json({ data: [{ status: "ok", id: "1" }] });
  server.resetHandlers();
  vi.clearAllMocks();
  vi.mocked(pushTokenService.prune).mockResolvedValue(0);
});
afterAll(() => server.close());

const sent = () => batches.flat();

describe("pushService.sendToUser — delivery", () => {
  it("sends one message per registered device", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["tok-a", "tok-b"]);

    await pushService.sendToUser("user-1", "MATCH_FOUND", { matchId: "m-1" });

    expect(sent().map((m) => m.to)).toEqual(["tok-a", "tok-b"]);
  });

  it("makes no network call when the user has no device", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue([]);

    // This is the common path in local dev and in every other test in the
    // suite — it has to be a clean no-op, not a failed request. MSW is running
    // with onUnhandledRequest: "error", so an unexpected call would surface.
    await pushService.sendToUser("user-1", "MATCH_FOUND", { matchId: "m-1" });

    expect(batches).toHaveLength(0);
  });

  it("splits into batches of 100, which is Expo's per-request cap", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => `tok-${i}`)
    );

    await pushService.sendToUser("user-1", "MATCH_FOUND", {});

    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });
});

describe("pushService.sendToUser — event to payload mapping", () => {
  it.each([
    ["MATCH_FOUND", "You've got a match"],
    ["DATE_ASSIGNED", "Your date is set"],
    ["PRE_DATE_REMINDER", "Your date is coming up"],
    ["DEBRIEF_NUDGE", "How did it go?"],
    ["CHECKIN_PROMPT", "Barney's checking in"],
  ] as const)("maps %s to its own copy", async (type, title) => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["tok-a"]);

    await pushService.sendToUser("user-1", type, { matchId: "m-1" });

    expect(sent()[0].title).toBe(title);
    expect(sent()[0].body).not.toBe("");
  });

  it("carries only what the tap handler routes on", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["tok-a"]);

    await pushService.sendToUser("user-1", "DATE_ASSIGNED", {
      matchId: "m-1",
      venue: "somewhere",
      dateTime: "2026-01-01T00:00:00.000Z",
    });

    // venue/dateTime stay in the persisted Notification row. Push payloads are
    // size-capped and are not a data channel.
    expect(sent()[0].data).toEqual({ type: "DATE_ASSIGNED", matchId: "m-1" });
  });

  it("survives a payload with no matchId", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["tok-a"]);

    await pushService.sendToUser("user-1", "CHECKIN_PROMPT", {});

    expect(sent()[0].data.type).toBe("CHECKIN_PROMPT");
  });
});

describe("pushService.sendToUser — pruning", () => {
  it("prunes tokens Expo reports as DeviceNotRegistered", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["good", "dead"]);
    respond = () =>
      HttpResponse.json({
        data: [
          { status: "ok", id: "1" },
          {
            status: "error",
            message: "not registered",
            details: { error: "DeviceNotRegistered" },
          },
        ],
      });

    await pushService.sendToUser("user-1", "MATCH_FOUND", {});

    // Ticket order maps positionally onto the batch — the dead token has to be
    // resolved by index, and picking the wrong one would silently delete a
    // working device.
    expect(pushTokenService.prune).toHaveBeenCalledWith(["dead"]);
  });

  it("leaves tokens alone for errors that are not DeviceNotRegistered", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["tok-a"]);
    respond = () =>
      HttpResponse.json({
        data: [
          { status: "error", message: "rate limited", details: { error: "MessageRateExceeded" } },
        ],
      });

    await pushService.sendToUser("user-1", "MATCH_FOUND", {});

    // A transient error must not cost the user their device registration.
    expect(pushTokenService.prune).not.toHaveBeenCalled();
  });

  it("does not prune on a fully successful send", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["tok-a"]);

    await pushService.sendToUser("user-1", "MATCH_FOUND", {});

    expect(pushTokenService.prune).not.toHaveBeenCalled();
  });
});

describe("pushService.sendToUser — failure is never the caller's problem", () => {
  it("swallows a non-2xx from Expo", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["tok-a"]);
    respond = () => new HttpResponse(null, { status: 502 });

    // The caller has already committed the match/date/followup write by the
    // time this runs. A push failure must not surface as an error on work
    // that succeeded.
    await expect(pushService.sendToUser("user-1", "MATCH_FOUND", {})).resolves.toBeUndefined();
  });

  it("swallows a network failure", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["tok-a"]);
    respond = () => HttpResponse.error();

    await expect(pushService.sendToUser("user-1", "MATCH_FOUND", {})).resolves.toBeUndefined();
  });

  it("swallows a failure to read the device list", async () => {
    vi.mocked(pushTokenService.listForUser).mockRejectedValue(new Error("db down"));

    await expect(pushService.sendToUser("user-1", "MATCH_FOUND", {})).resolves.toBeUndefined();
    expect(batches).toHaveLength(0);
  });

  it("swallows a failure to prune", async () => {
    vi.mocked(pushTokenService.listForUser).mockResolvedValue(["dead"]);
    vi.mocked(pushTokenService.prune).mockRejectedValue(new Error("db down"));
    respond = () =>
      HttpResponse.json({
        data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
      });

    await expect(pushService.sendToUser("user-1", "MATCH_FOUND", {})).resolves.toBeUndefined();
  });
});
