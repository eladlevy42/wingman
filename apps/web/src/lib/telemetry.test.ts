import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The web suite runs under Node, so the browser globals this module needs are
// stubbed rather than provided by a DOM. Kept minimal and explicit: what the
// module touches is exactly what the ADR's promises are about — crypto for the
// per-load anonymous id, localStorage (which it must never write), and
// visibilitychange for the flush-on-hide.
let fetchMock: ReturnType<typeof vi.fn>;
let localStorageSetItem: ReturnType<typeof vi.fn>;
let visibilityState: "visible" | "hidden";
let visibilityListeners: (() => void)[];

async function loadTelemetry() {
  vi.resetModules();
  return import("./telemetry");
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ accepted: 1, dropped: 0 }),
  });
  localStorageSetItem = vi.fn();
  visibilityState = "visible";
  visibilityListeners = [];

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", {
    setItem: localStorageSetItem,
    getItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal("sessionStorage", { setItem: localStorageSetItem, getItem: vi.fn() });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") visibilityListeners.push(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") {
        visibilityListeners = visibilityListeners.filter((l) => l !== listener);
      }
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sentBatches(): { userId?: string; anonSessionId?: string; events: unknown[] }[] {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string) as never
  );
}

describe("web telemetry", () => {
  it("posts a screen view to the telemetry endpoint", async () => {
    const { trackScreen, flushTelemetry } = await loadTelemetry();

    trackScreen("/barney/phase2");
    await flushTelemetry();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/telemetry");
    expect((init as RequestInit).method).toBe("POST");
    expect(sentBatches()[0]!.events).toEqual([
      { type: "SCREEN_VIEWED", payload: { screen: "interview_wants", client: "web" } },
    ]);
  });

  it("posts a funnel tap with the screen it was tapped on", async () => {
    const { trackAction, flushTelemetry } = await loadTelemetry();

    trackAction("/register", "register_submitted");
    await flushTelemetry();

    expect(sentBatches()[0]!.events).toEqual([
      {
        type: "CTA_TAPPED",
        payload: { screen: "register", action: "register_submitted", client: "web" },
      },
    ]);
  });

  // docs/adr/0038: the anonymous id lives for one page load and no longer.
  it("never writes the anonymous session id to localStorage or sessionStorage", async () => {
    const { trackScreen, setTelemetryUser, flushTelemetry } = await loadTelemetry();

    trackScreen("/register");
    setTelemetryUser("u-1");
    await flushTelemetry();

    expect(localStorageSetItem).not.toHaveBeenCalled();
    expect(sentBatches().find((batch) => batch.anonSessionId != null)!.anonSessionId).toBeTruthy();
  });

  it("does not backfill a userId onto events queued before sign-in", async () => {
    const { trackScreen, setTelemetryUser, flushTelemetry } = await loadTelemetry();

    trackScreen("/register");
    setTelemetryUser("u-1");
    trackScreen("/waiting");
    await flushTelemetry();

    expect(sentBatches().find((batch) => batch.anonSessionId != null)!.userId).toBeUndefined();
    expect(sentBatches().find((batch) => batch.userId != null)!.anonSessionId).toBeUndefined();
  });

  it("drops events when the api answers with an error, without throwing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const { trackScreen, flushTelemetry, queuedTelemetryCount } = await loadTelemetry();

    trackScreen("/waiting");
    await expect(flushTelemetry()).resolves.toBeUndefined();

    expect(queuedTelemetryCount()).toBe(0);
  });

  it("flushes when the tab is hidden", async () => {
    const { trackScreen, startTelemetry } = await loadTelemetry();
    const stop = startTelemetry();

    trackScreen("/pitch");
    visibilityState = "hidden";
    visibilityListeners.forEach((listener) => listener());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not flush when the tab merely becomes visible again", async () => {
    const { trackScreen, startTelemetry } = await loadTelemetry();
    const stop = startTelemetry();

    trackScreen("/pitch");
    visibilityListeners.forEach((listener) => listener());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    stop();
  });

  it("stops the timer and removes the listener on teardown", async () => {
    const { startTelemetry } = await loadTelemetry();

    const stop = startTelemetry();
    expect(visibilityListeners).toHaveLength(1);
    stop();
    expect(visibilityListeners).toHaveLength(0);
  });
});

describe("web screen views are not double-counted", () => {
  // StrictMode double-invokes effects in development, so without the gate every
  // screen in a dev funnel is counted twice.
  it("ignores a repeat of the screen already showing", async () => {
    const { trackScreen, flushTelemetry } = await loadTelemetry();

    trackScreen("/register");
    trackScreen("/register");
    await flushTelemetry();

    expect(sentBatches()[0]!.events).toHaveLength(1);
  });

  it("still counts a return to an earlier screen", async () => {
    const { trackScreen, flushTelemetry } = await loadTelemetry();

    trackScreen("/register");
    trackScreen("/login");
    trackScreen("/register");
    await flushTelemetry();

    expect(sentBatches()[0]!.events).toHaveLength(3);
  });
});

// The dev server is deliberately reachable over plain http from a phone on the
// same Wi-Fi (vite.config.ts `host: true`), and `crypto.randomUUID` exists only
// in a secure context. An unguarded call at module scope would throw during
// import and take the whole app down on exactly that setup.
describe("the anonymous id survives an insecure origin", () => {
  it("still loads and emits when crypto.randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {
      // What an insecure origin actually offers: getRandomValues, no randomUUID.
      getRandomValues: (array: Uint8Array) => {
        array.fill(7);
        return array;
      },
    });

    const { trackScreen, flushTelemetry } = await loadTelemetry();
    trackScreen("/register");
    await flushTelemetry();

    expect(sentBatches()[0]!.anonSessionId).toBe("07".repeat(16));
  });

  it("still loads when there is no crypto at all", async () => {
    vi.stubGlobal("crypto", undefined);

    const { trackScreen, flushTelemetry } = await loadTelemetry();
    trackScreen("/register");
    await flushTelemetry();

    expect(sentBatches()[0]!.anonSessionId).toBeTruthy();
  });
});
