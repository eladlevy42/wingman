import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageStub = { setItem: (k: string, v: string) => Promise<void>; __reset: () => void };
type AppStateStub = {
  __emit: (status: "active" | "background" | "inactive") => void;
  __listenerCount: () => number;
};

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Loads a fresh copy of the telemetry module, plus the native stubs from the
 * SAME module graph.
 *
 * The module holds its anonymous session id and its queue at module scope, so
 * each test needs its own copy — otherwise one test's queued events leak into
 * the next. Re-importing the stubs alongside it matters just as much: after a
 * resetModules the module under test wires itself to a NEW AppState instance,
 * and a listener assertion against the old one silently reads zero.
 */
async function loadTelemetry() {
  vi.resetModules();
  const telemetry = await import("./telemetry");
  const { AppState } = await import("react-native");
  const storage = (await import("@react-native-async-storage/async-storage")).default;
  return {
    ...telemetry,
    appState: AppState as unknown as AppStateStub,
    storage: storage as unknown as StorageStub,
  };
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ accepted: 1, dropped: 0 }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function sentBatches(): { userId?: string; anonSessionId?: string; events: unknown[] }[] {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string) as never
  );
}

describe("mobile telemetry", () => {
  it("sends a screen view for the current route", async () => {
    const { trackScreen, flushTelemetry } = await loadTelemetry();

    trackScreen("/barney/phase1");
    await flushTelemetry();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/telemetry");
    expect((init as RequestInit).method).toBe("POST");
    expect(sentBatches()[0]!.events).toEqual([
      { type: "SCREEN_VIEWED", payload: { screen: "interview_self", client: "mobile" } },
    ]);
  });

  it("sends a funnel tap with the screen it was tapped on", async () => {
    const { trackAction, flushTelemetry } = await loadTelemetry();

    trackAction("/register", "register_submitted");
    await flushTelemetry();

    expect(sentBatches()[0]!.events).toEqual([
      {
        type: "CTA_TAPPED",
        payload: { screen: "register", action: "register_submitted", client: "mobile" },
      },
    ]);
  });

  // docs/adr/0038: the anonymous id is per launch and in memory. A persisted id
  // stitched to a userId at registration is the retroactive-identification
  // pattern the ADR rejects, so it must never reach the device's storage.
  it("never writes the anonymous session id to AsyncStorage", async () => {
    const { trackScreen, setTelemetryUser, flushTelemetry, storage } = await loadTelemetry();
    const setItem = vi.spyOn(storage, "setItem");

    trackScreen("/register");
    setTelemetryUser("u-1");
    trackScreen("/verified");
    await flushTelemetry();

    // Nothing at all was persisted — not under a telemetry key, not under any
    // other, and not as part of a larger stored object.
    expect(setItem).not.toHaveBeenCalled();
    const anonId = sentBatches().find((batch) => batch.anonSessionId != null)!.anonSessionId!;
    expect(anonId).toBeTruthy();
  });

  it("gives each launch its own anonymous id", async () => {
    const first = await loadTelemetry();
    first.trackScreen("/register");
    await first.flushTelemetry();

    const second = await loadTelemetry();
    second.trackScreen("/register");
    await second.flushTelemetry();

    const [a, b] = sentBatches();
    expect(a!.anonSessionId).not.toBe(b!.anonSessionId);
  });

  it("does not backfill a userId onto events queued before sign-in", async () => {
    const { trackScreen, setTelemetryUser, flushTelemetry } = await loadTelemetry();

    trackScreen("/register");
    setTelemetryUser("u-1");
    trackScreen("/waiting");
    await flushTelemetry();

    const anonBatch = sentBatches().find((batch) => batch.anonSessionId != null)!;
    const userBatch = sentBatches().find((batch) => batch.userId != null)!;
    expect(anonBatch.userId).toBeUndefined();
    expect(anonBatch.events).toHaveLength(1);
    expect(userBatch.anonSessionId).toBeUndefined();
  });

  it("drops events when the api is unreachable, without surfacing an error", async () => {
    fetchMock.mockRejectedValue(new Error("Network request failed"));
    const { trackScreen, flushTelemetry, queuedTelemetryCount } = await loadTelemetry();

    trackScreen("/waiting");
    await expect(flushTelemetry()).resolves.toBeUndefined();

    expect(queuedTelemetryCount()).toBe(0);
    // Nothing is held for a retry, so an outage cannot grow a backlog.
    await flushTelemetry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("flushes when the app goes to the background", async () => {
    const { trackScreen, startTelemetry, appState } = await loadTelemetry();
    const stop = startTelemetry();

    trackScreen("/pitch");
    appState.__emit("background");
    // The flush is fire-and-forget from the listener; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("flushes on the interval while the app is in the foreground", async () => {
    vi.useFakeTimers();
    const { trackScreen, startTelemetry, FLUSH_INTERVAL_MS } = await loadTelemetry();
    const stop = startTelemetry();

    trackScreen("/waiting");
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops the timer and releases the AppState listener on teardown", async () => {
    const { trackScreen, startTelemetry, appState } = await loadTelemetry();
    const before = appState.__listenerCount();

    const stop = startTelemetry();
    expect(appState.__listenerCount()).toBe(before + 1);
    stop();
    expect(appState.__listenerCount()).toBe(before);

    trackScreen("/waiting");
    appState.__emit("background");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mobile screen views are not double-counted", () => {
  it("ignores a repeat of the screen already showing", async () => {
    const { trackScreen, flushTelemetry } = await loadTelemetry();

    trackScreen("/register");
    // The root layout's effect can run twice for one navigation.
    trackScreen("/register");
    await flushTelemetry();

    expect(sentBatches()[0]!.events).toHaveLength(1);
  });
});
