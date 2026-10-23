import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearNotifications, getNotifications } from "@wingman/shared";
import {
  notificationCursorKey,
  pollNotificationsOnce,
  primeNotificationCursor,
} from "./notificationPoll";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const KEY = notificationCursorKey(USER_ID);

const storage = AsyncStorage as typeof AsyncStorage & { __reset: () => void };

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "9f1c0f7e-59a1-4a3f-9c7e-6d2a1b0e4c11",
    userId: USER_ID,
    type: "MATCH_FOUND",
    payload: {},
    createdAt: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

// Answers every request with the given notification rows, and records the urls
// so the `since` cursor actually sent can be asserted on.
function stubNotifications(...batches: ReturnType<typeof row>[][]) {
  const urls: string[] = [];
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const notifications = batches[Math.min(call++, batches.length - 1)] ?? [];
      return { ok: true, status: 200, json: async () => ({ notifications }) };
    })
  );
  return urls;
}

beforeEach(() => {
  storage.__reset();
  clearNotifications();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("primeNotificationCursor", () => {
  // Without this, a user who signs in on a new phone is handed every
  // notification they have ever received as a stack of fresh banners.
  it("starts a first-time cursor at now", async () => {
    await primeNotificationCursor(USER_ID, new Date("2026-08-27T09:00:00.000Z"));

    expect(await AsyncStorage.getItem(KEY)).toBe("2026-08-27T09:00:00.000Z");
  });

  // The other half, and the one that would silently lose notifications: on
  // every launch after the first, this must leave the stored position alone or
  // anything that arrived while the app was closed is skipped.
  it("never moves a cursor that already exists", async () => {
    await AsyncStorage.setItem(KEY, "2026-08-27T08:00:00.000Z");

    await primeNotificationCursor(USER_ID, new Date("2026-08-27T09:00:00.000Z"));

    expect(await AsyncStorage.getItem(KEY)).toBe("2026-08-27T08:00:00.000Z");
  });

  it("keeps a separate cursor per user", async () => {
    const other = "11111111-2222-3333-4444-555555555555";

    await primeNotificationCursor(USER_ID, new Date("2026-08-27T09:00:00.000Z"));
    await primeNotificationCursor(other, new Date("2026-08-27T11:00:00.000Z"));

    expect(await AsyncStorage.getItem(notificationCursorKey(other))).toBe(
      "2026-08-27T11:00:00.000Z"
    );
    expect(await AsyncStorage.getItem(KEY)).toBe("2026-08-27T09:00:00.000Z");
  });
});

describe("pollNotificationsOnce", () => {
  it("hands every returned row to the store", async () => {
    stubNotifications([row({ type: "MATCH_FOUND" }), row({ type: "DATE_ASSIGNED" })]);

    const delivered = await pollNotificationsOnce(USER_ID);

    expect(delivered).toBe(2);
    expect(getNotifications().map((n) => n.type)).toEqual(["MATCH_FOUND", "DATE_ASSIGNED"]);
  });

  it("sends the stored cursor as `since`", async () => {
    await AsyncStorage.setItem(KEY, "2026-08-27T09:00:00.000Z");
    const urls = stubNotifications([]);

    await pollNotificationsOnce(USER_ID);

    expect(urls[0]).toContain(`since=${encodeURIComponent("2026-08-27T09:00:00.000Z")}`);
  });

  it("advances the cursor past the newest row", async () => {
    stubNotifications([
      row({ createdAt: "2026-08-27T10:00:00.000Z" }),
      row({ createdAt: "2026-08-27T10:05:00.000Z" }),
    ]);

    await pollNotificationsOnce(USER_ID);

    expect(await AsyncStorage.getItem(KEY)).toBe("2026-08-27T10:05:00.000Z");
  });

  // The bug this rules out is the one a user actually notices: the same match
  // announced again every five seconds, forever.
  it("does not re-deliver a row on the next poll", async () => {
    stubNotifications([row({ createdAt: "2026-08-27T10:00:00.000Z" })], []);

    await pollNotificationsOnce(USER_ID);
    const second = await pollNotificationsOnce(USER_ID);

    expect(second).toBe(0);
    expect(getNotifications()).toHaveLength(1);
  });

  it("leaves the cursor alone when nothing came back", async () => {
    await AsyncStorage.setItem(KEY, "2026-08-27T09:00:00.000Z");
    stubNotifications([]);

    await pollNotificationsOnce(USER_ID);

    expect(await AsyncStorage.getItem(KEY)).toBe("2026-08-27T09:00:00.000Z");
  });

  // The sign-out race. The tick checks who is signed in before it fetches, but
  // the fetch is where the time goes: someone can sign out inside it, and
  // clearUser empties a store this batch would otherwise refill with the
  // previous account's notifications.
  describe("a sign-out during the request", () => {
    it("delivers nothing when the signed-in user changed mid-flight", async () => {
      stubNotifications([row({ type: "MATCH_FOUND" })]);

      const delivered = await pollNotificationsOnce(USER_ID, async () => false);

      expect(delivered).toBe(0);
      expect(getNotifications()).toHaveLength(0);
    });

    // The rows still belong to that user. Leaving the cursor put is what lets
    // them see the notification if they sign back in on this handset.
    it("leaves the cursor where it was, so the rows are not lost", async () => {
      await AsyncStorage.setItem(KEY, "2026-08-27T09:00:00.000Z");
      stubNotifications([row({ createdAt: "2026-08-27T10:00:00.000Z" })]);

      await pollNotificationsOnce(USER_ID, async () => false);

      expect(await AsyncStorage.getItem(KEY)).toBe("2026-08-27T09:00:00.000Z");
    });

    it("delivers as usual when the same user is still signed in", async () => {
      stubNotifications([row({ type: "MATCH_FOUND" })]);

      const delivered = await pollNotificationsOnce(USER_ID, async () => true);

      expect(delivered).toBe(1);
      expect(getNotifications()).toHaveLength(1);
    });
  });

  describe("failure", () => {
    // A poll runs on a timer with nobody awaiting it. Throwing would surface as
    // an unhandled rejection inside an interval, which is far worse than a
    // missed tick.
    it("returns 0 rather than throwing when the api is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      await expect(pollNotificationsOnce(USER_ID)).resolves.toBe(0);
    });

    it("returns 0 rather than throwing on a non-2xx response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
      );

      await expect(pollNotificationsOnce(USER_ID)).resolves.toBe(0);
    });

    it("delivers nothing when the response does not match the schema", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ notifications: [{ nope: true }] }),
        })
      );

      await expect(pollNotificationsOnce(USER_ID)).resolves.toBe(0);
      expect(getNotifications()).toHaveLength(0);
    });

    // Contract drift must not silently advance the cursor: the rows are still
    // out there, and a retry after a fix should still find them.
    it("does not advance the cursor on a failed poll", async () => {
      await AsyncStorage.setItem(KEY, "2026-08-27T09:00:00.000Z");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      await pollNotificationsOnce(USER_ID);

      expect(await AsyncStorage.getItem(KEY)).toBe("2026-08-27T09:00:00.000Z");
    });
  });
});
