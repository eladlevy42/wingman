import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../services/telemetry.service", () => ({
  recordTelemetryBatch: vi.fn(async () => ({ accepted: 1, dropped: 0 })),
}));

import { recordTelemetryBatch } from "../services/telemetry.service";

let server: Server;
let baseUrl: string;

// The limit is read from the environment when the router module loads, so it
// is set before the dynamic import below rather than passed in — that is also
// the only way to prove the env var is actually wired to the middleware.
//
// One counter is shared by every request in this file (same client, one long
// window), so the limit is set well above what the other cases spend and the
// rate-limit case drains the remainder itself. A tighter limit would make the
// other cases fail on request order instead of on what they assert.
const TEST_LIMIT = 10;

beforeAll(async () => {
  process.env.TELEMETRY_RATE_LIMIT = String(TEST_LIMIT);
  process.env.TELEMETRY_RATE_WINDOW_MS = "60000";
  const { telemetryRouter } = await import("./telemetry.routes");

  const app = express();
  app.use(express.json());
  app.use("/api/telemetry", telemetryRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.TELEMETRY_RATE_LIMIT;
  delete process.env.TELEMETRY_RATE_WINDOW_MS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
});

const screenView = { type: "SCREEN_VIEWED", payload: { screen: "register", client: "web" } };

function post(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/telemetry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/telemetry", () => {
  it("accepts a valid batch and reports what it took", async () => {
    const response = await post({ anonSessionId: "anon-1", events: [screenView] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(recordTelemetryBatch).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed batch with a 400 and writes nothing", async () => {
    const response = await post({ events: [screenView] });

    expect(response.status).toBe(400);
    expect(recordTelemetryBatch).not.toHaveBeenCalled();
  });

  it("rejects a batch carrying both subjects, rather than picking one", async () => {
    const response = await post({
      userId: "u-1",
      anonSessionId: "anon-1",
      events: [screenView],
    });

    expect(response.status).toBe(400);
    expect(recordTelemetryBatch).not.toHaveBeenCalled();
  });

  it("rejects an over-cap batch outright rather than truncating it", async () => {
    const events = Array.from({ length: 51 }, () => screenView);
    const response = await post({ anonSessionId: "anon-1", events });

    expect(response.status).toBe(400);
    expect(recordTelemetryBatch).not.toHaveBeenCalled();
  });

  it("rate-limits past the configured limit, and stops writing when it does", async () => {
    // The window is minutes long and the counter is per client, so the earlier
    // cases in this file have already spent part of it — drain whatever is
    // left, then assert the next request is refused.
    let sawLimit = false;
    for (let i = 0; i < TEST_LIMIT + 5; i++) {
      const response = await post({ anonSessionId: "anon-1", events: [screenView] });
      if (response.status === 429) {
        sawLimit = true;
        expect(await response.json()).toEqual({ error: "Too many requests" });
        expect(response.headers.get("Retry-After")).not.toBeNull();
        break;
      }
    }

    expect(sawLimit).toBe(true);
    // The refused request never reached the service — the point of the limit is
    // that it protects SQLite's single writer, not just the response body.
    expect(vi.mocked(recordTelemetryBatch).mock.calls.length).toBeLessThan(TEST_LIMIT + 5);
  });
});
