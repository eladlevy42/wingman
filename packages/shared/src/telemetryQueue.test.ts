import { describe, expect, it, vi } from "vitest";
import {
  createScreenViewGate,
  createTelemetryQueue,
  groupBySubject,
  chunk,
} from "./telemetryQueue";
import { MAX_TELEMETRY_BATCH, type TelemetryBatch } from "./schemas/telemetry";

function collector() {
  const sent: TelemetryBatch[] = [];
  return {
    sent,
    send: vi.fn(async (batch: TelemetryBatch) => {
      sent.push(batch);
    }),
  };
}

describe("createTelemetryQueue", () => {
  it("sends what was tracked, under the anonymous id when signed out", async () => {
    const { sent, send } = collector();
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send });

    queue.track("SCREEN_VIEWED", { screen: "register", client: "web" });
    await queue.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.anonSessionId).toBe("anon-1");
    expect(sent[0]!.userId).toBeUndefined();
    expect(sent[0]!.events).toEqual([
      { type: "SCREEN_VIEWED", payload: { screen: "register", client: "web" } },
    ]);
  });

  it("attributes events tracked after sign-in to the user", async () => {
    const { sent, send } = collector();
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send });

    queue.setUser("u-1");
    queue.track("SCREEN_VIEWED", { screen: "waiting", client: "mobile" });
    await queue.flush();

    expect(sent[0]!.userId).toBe("u-1");
    expect(sent[0]!.anonSessionId).toBeUndefined();
  });

  // The non-linkage guarantee of docs/adr/0038, at the point it would actually
  // be broken: the events that led to a registration keep the anonymous
  // subject they were emitted under.
  it("never backfills a userId onto events queued before sign-in", async () => {
    const { sent, send } = collector();
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send });

    queue.track("SCREEN_VIEWED", { screen: "register", client: "web" });
    queue.track("CTA_TAPPED", {
      screen: "register",
      action: "register_submitted",
      client: "web",
    });
    // Registration happens here, and only now is there a user at all.
    queue.setUser("u-1");
    queue.track("SCREEN_VIEWED", { screen: "verified", client: "web" });
    await queue.flush();

    const anonBatch = sent.find((batch) => batch.anonSessionId != null)!;
    const userBatch = sent.find((batch) => batch.userId != null)!;
    expect(anonBatch.events.map((e) => e.type)).toEqual(["SCREEN_VIEWED", "CTA_TAPPED"]);
    expect(anonBatch.userId).toBeUndefined();
    expect(userBatch.events.map((e) => e.type)).toEqual(["SCREEN_VIEWED"]);
  });

  it("returns to the anonymous id on sign-out", async () => {
    const { sent, send } = collector();
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send });

    queue.setUser("u-1");
    queue.setUser(null);
    queue.track("SCREEN_VIEWED", { screen: "splash", client: "mobile" });
    await queue.flush();

    expect(sent[0]!.anonSessionId).toBe("anon-1");
    expect(sent[0]!.userId).toBeUndefined();
  });

  it("drops the oldest events past the cap rather than growing without bound", async () => {
    const { sent, send } = collector();
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send, maxQueued: 3 });

    for (const screen of ["splash", "welcome", "register", "login"] as const) {
      queue.track("SCREEN_VIEWED", { screen, client: "web" });
    }
    expect(queue.size()).toBe(3);
    await queue.flush();

    // The newest three survived; "splash" was dropped from the front.
    expect(sent[0]!.events.map((e) => (e.payload as { screen: string }).screen)).toEqual([
      "welcome",
      "register",
      "login",
    ]);
  });

  it("splits a flush into batches the endpoint will accept", async () => {
    const { sent, send } = collector();
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send, maxQueued: 1000 });

    for (let i = 0; i < MAX_TELEMETRY_BATCH + 5; i++) {
      queue.track("SCREEN_VIEWED", { screen: "waiting", client: "mobile" });
    }
    await queue.flush();

    expect(sent).toHaveLength(2);
    expect(sent[0]!.events).toHaveLength(MAX_TELEMETRY_BATCH);
    expect(sent[1]!.events).toHaveLength(5);
  });

  it("drops a failed batch instead of retrying it forever", async () => {
    const send = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send });

    queue.track("SCREEN_VIEWED", { screen: "waiting", client: "mobile" });
    // Never rejects: an unreachable API must not surface as an app error.
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(queue.size()).toBe(0);

    // And the next flush has nothing left to send — no growing retry backlog
    // on a phone that is on the wrong LAN.
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not send the same event twice when two flushes overlap", async () => {
    const { sent, send } = collector();
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send });

    queue.track("SCREEN_VIEWED", { screen: "pitch", client: "mobile" });
    await Promise.all([queue.flush(), queue.flush()]);

    expect(sent.flatMap((batch) => batch.events)).toHaveLength(1);
  });

  // This promise is the chain every later flush queues behind, so a rejection
  // here would turn one failure into every subsequent flush rejecting.
  it("keeps working after a flush whose internals throw", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send });

    queue.track("SCREEN_VIEWED", { screen: "waiting", client: "mobile" });
    await expect(queue.flush()).resolves.toBeUndefined();

    queue.track("SCREEN_VIEWED", { screen: "pitch", client: "mobile" });
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when there is nothing queued", async () => {
    const { send } = collector();
    const queue = createTelemetryQueue({ anonSessionId: "anon-1", send });

    await queue.flush();

    expect(send).not.toHaveBeenCalled();
  });
});

describe("groupBySubject", () => {
  it("keeps each subject in its own batch", () => {
    const batches = groupBySubject([
      { type: "SCREEN_VIEWED", payload: {}, userId: null, anonSessionId: "a" },
      { type: "SCREEN_VIEWED", payload: {}, userId: "u-1", anonSessionId: "a" },
      { type: "SCREEN_VIEWED", payload: {}, userId: "u-2", anonSessionId: "a" },
    ]);

    expect(batches).toHaveLength(3);
    expect(batches.every((batch) => (batch.userId == null) !== (batch.anonSessionId == null))).toBe(
      true
    );
  });
});

describe("chunk", () => {
  it("splits evenly and leaves a short tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns nothing for an empty list", () => {
    expect(chunk([], 10)).toEqual([]);
  });
});

describe("createScreenViewGate", () => {
  it("suppresses a repeat of the screen already showing", () => {
    const gate = createScreenViewGate();

    expect(gate("register")).toBe(true);
    // React StrictMode runs the effect twice for one navigation.
    expect(gate("register")).toBe(false);
  });

  it("counts a genuine return to an earlier screen", () => {
    const gate = createScreenViewGate();

    expect(gate("register")).toBe(true);
    expect(gate("login")).toBe(true);
    expect(gate("register")).toBe(true);
  });

  it("gives each gate its own memory", () => {
    const web = createScreenViewGate();
    const mobile = createScreenViewGate();

    expect(web("splash")).toBe(true);
    expect(mobile("splash")).toBe(true);
  });
});
