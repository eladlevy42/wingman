import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Notifications from "expo-notifications";
import { registerForPushNotifications, unregisterPushNotifications } from "./push";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TOKEN = "ExponentPushToken[test-token]";

const stub = Notifications as typeof Notifications & { __reset: () => void };

function record() {
  return {
    id: "9f1c0f7e-59a1-4a3f-9c7e-6d2a1b0e4c11",
    userId: USER_ID,
    token: TOKEN,
    platform: "android",
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T10:00:00.000Z",
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stub.__reset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => record() });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function lastRequest() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit };
}

describe("registerForPushNotifications", () => {
  it("registers the token against the user", async () => {
    await expect(registerForPushNotifications(USER_ID)).resolves.toBe(TOKEN);

    const { url, init } = lastRequest();
    expect(url).toContain(`/api/users/${USER_ID}/push-tokens`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN, platform: "android" });
  });

  it("creates the Android channel before asking for a token", async () => {
    await registerForPushNotifications(USER_ID);

    // Android files a notification away silently unless a high-importance
    // channel exists, so this has to happen before the first push can arrive.
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ importance: Notifications.AndroidImportance.HIGH })
    );
  });

  it("does not re-prompt when permission is already granted", async () => {
    await registerForPushNotifications(USER_ID);

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("prompts when permission has not been granted yet", async () => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as never);

    await registerForPushNotifications(USER_ID);

    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
  });

  it("gives up quietly when permission is refused", async () => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as never);
    vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
      granted: false,
      canAskAgain: false,
    } as never);

    // Null, not a throw: this runs inside sign-in, which must not fail because
    // someone declined notifications.
    await expect(registerForPushNotifications(USER_ID)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not re-prompt someone who has permanently refused", async () => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      granted: false,
      canAskAgain: false,
    } as never);

    await registerForPushNotifications(USER_ID);

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("returns null when Expo cannot mint a token", async () => {
    // The iOS simulator path, and any misconfigured project.
    vi.mocked(Notifications.getExpoPushTokenAsync).mockRejectedValue(new Error("no token"));

    await expect(registerForPushNotifications(USER_ID)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the api rejects the registration", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(registerForPushNotifications(USER_ID)).resolves.toBeNull();
  });

  it("returns null when the api is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));

    await expect(registerForPushNotifications(USER_ID)).resolves.toBeNull();
  });
});

describe("unregisterPushNotifications", () => {
  it("deletes the registration for this device", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });

    await unregisterPushNotifications(USER_ID);

    const { url, init } = lastRequest();
    expect(url).toContain(`/api/users/${USER_ID}/push-tokens`);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
  });

  it("never throws, so a sign-out always completes", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));

    await expect(unregisterPushNotifications(USER_ID)).resolves.toBeUndefined();
  });

  it("gives up rather than hanging a sign-out on a dead network", async () => {
    vi.useFakeTimers();
    // Never settles — the mobile api client has no request timeout of its own,
    // so without the race in unregisterPushNotifications this would hold the
    // sign-out spinner until the OS gave up.
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const pending = unregisterPushNotifications(USER_ID);
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
