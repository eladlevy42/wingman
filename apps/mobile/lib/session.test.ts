import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addNotification,
  clearNotifications,
  getActiveNotification,
  getBadgeCount,
  getNotifications,
  type UserResponse,
} from "@wingman/shared";
import { SESSION_KEY, clearUser, loadUser, parseStoredUser, saveUser } from "./session";
import { loadBarneySession, saveBarneySession } from "./barneySession";

const USER: UserResponse = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  name: "Dana",
  email: "dana@example.com",
  gender: "female",
  createdAt: "2026-08-25T10:00:00.000Z",
};

// The stub exposes a reset hook the real native module does not have.
const storage = AsyncStorage as typeof AsyncStorage & { __reset: () => void };

beforeEach(() => {
  storage.__reset();
  clearNotifications();
  // saveUser/clearUser now register and unregister this device for push
  // (#479). Neither is what these tests are about, but both reach the network,
  // and without a stub the real fetch dials the stub manifest's LAN address and
  // hangs until the suite times out.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // A valid PushTokenRecord: registration parses the response, and an
      // unparseable one would log a swallowed failure on every test here.
      json: async () => ({
        id: "9f1c0f7e-59a1-4a3f-9c7e-6d2a1b0e4c11",
        userId: USER.id,
        token: "ExponentPushToken[test-token]",
        platform: "android",
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T10:00:00.000Z",
      }),
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseStoredUser", () => {
  it("returns null when nothing is stored", () => {
    expect(parseStoredUser(null)).toBeNull();
  });

  it("returns null for a value that is not JSON", () => {
    expect(parseStoredUser("{oops")).toBeNull();
  });

  it("returns null for JSON that no longer matches the shared schema", () => {
    // A stored session from before a schema change must log the user out, not
    // flow a half-valid user into the api client.
    expect(parseStoredUser(JSON.stringify({ id: "not-a-uuid" }))).toBeNull();
  });

  it("returns the user when the stored value is valid", () => {
    expect(parseStoredUser(JSON.stringify(USER))).toEqual(USER);
  });
});

describe("session storage", () => {
  it("round-trips a user through storage", async () => {
    await saveUser(USER);
    expect(await loadUser()).toEqual(USER);
  });

  it("reads back null once the session is cleared", async () => {
    await saveUser(USER);
    await clearUser();
    expect(await loadUser()).toBeNull();
  });

  it("treats a corrupt stored session as no session", async () => {
    await AsyncStorage.setItem(SESSION_KEY, "not json at all");
    expect(await loadUser()).toBeNull();
  });

  // #496: a resumable interview is stored alongside the user. Signing out has
  // to take it with them, or the next person to sign in on this device is
  // offered someone else's half-finished conversation.
  it("clears a stored interview along with the user", async () => {
    const now = Date.now();
    await saveUser(USER);
    await saveBarneySession({
      sessionId: "11111111-1111-1111-1111-111111111111",
      userId: USER.id,
      mode: "interview_self",
      savedAt: now,
      messages: [{ role: "assistant", content: "How old are you?" }],
      section: null,
      progress: { answered: 0, total: 18 },
      input: { kind: "text" },
    });
    expect(await loadBarneySession(now)).not.toBeNull();

    await clearUser();

    expect(await loadUser()).toBeNull();
    expect(await loadBarneySession(now)).toBeNull();
  });
});

describe("the notification store across a sign-out", () => {
  // The notification store is a module singleton, so it outlives the session
  // the way barneySession did before #496. Two accounts share one handset here.
  it("is emptied, so the next user cannot read the last one's notifications", async () => {
    addNotification({ userId: USER.id, type: "MATCH_FOUND", payload: {} });
    expect(getNotifications()).toHaveLength(1);
    expect(getBadgeCount()).toBe(1);

    await saveUser(USER);
    await clearUser();

    expect(getNotifications()).toHaveLength(0);
    expect(getBadgeCount()).toBe(0);
    expect(getActiveNotification()).toBeNull();
  });
});
