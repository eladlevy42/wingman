import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../services/eval/evalRun.service", () => ({
  startEvalRun: vi.fn(),
  listEvalRuns: vi.fn(),
  getEvalRun: vi.fn(),
  EvalRunNotFoundError: class EvalRunNotFoundError extends Error {},
}));

vi.mock("../services/eval/track1.service", () => ({
  EvalPreconditionError: class EvalPreconditionError extends Error {},
}));

vi.mock("../services/eval/runRegistry", () => ({
  getActiveRun: vi.fn(),
  requestStop: vi.fn(),
}));

import { evalRouter } from "./eval.routes";
import {
  startEvalRun,
  listEvalRuns,
  getEvalRun,
  EvalRunNotFoundError,
} from "../services/eval/evalRun.service";
import { EvalPreconditionError } from "../services/eval/track1.service";
import { requestStop } from "../services/eval/runRegistry";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/eval", evalRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
});

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    track: 1,
    status: "running",
    config: { barneyModel: "sonnet", judgeModel: "sonnet" },
    costUsd: 0,
    durationMs: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("POST /api/eval/runs", () => {
  it("starts a run and returns 201", async () => {
    const run = summary();
    vi.mocked(startEvalRun).mockResolvedValue(run as never);

    const res = await fetch(`${baseUrl}/api/eval/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track: 1 }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(run);
    expect(startEvalRun).toHaveBeenCalledWith(1, undefined);
  });

  it("returns 400 for an invalid track number", async () => {
    const res = await fetch(`${baseUrl}/api/eval/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track: 9 }),
    });

    expect(res.status).toBe(400);
    expect(startEvalRun).not.toHaveBeenCalled();
  });

  it("returns 409 when the eval precondition fails", async () => {
    vi.mocked(startEvalRun).mockRejectedValue(new EvalPreconditionError("DB not seeded"));

    const res = await fetch(`${baseUrl}/api/eval/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track: 1 }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "DB not seeded" });
  });

  it("returns 500 on an unexpected error", async () => {
    vi.mocked(startEvalRun).mockRejectedValue(new Error("boom"));

    const res = await fetch(`${baseUrl}/api/eval/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track: 2 }),
    });

    expect(res.status).toBe(500);
  });
});

describe("GET /api/eval/runs", () => {
  it("returns run history", async () => {
    const runs = [summary(), summary({ id: "22222222-2222-2222-2222-222222222222" })];
    vi.mocked(listEvalRuns).mockResolvedValue(runs as never);

    const res = await fetch(`${baseUrl}/api/eval/runs?track=1`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(runs);
    expect(listEvalRuns).toHaveBeenCalledWith(1, undefined);
  });

  it("returns 400 for an invalid track filter", async () => {
    const res = await fetch(`${baseUrl}/api/eval/runs?track=9`);

    expect(res.status).toBe(400);
  });
});

describe("GET /api/eval/runs/:id", () => {
  it("returns the run detail", async () => {
    const run = {
      ...summary(),
      status: "completed",
      result: { meanPrecision: 1, perUser: [] },
      error: null,
    };
    vi.mocked(getEvalRun).mockResolvedValue(run as never);

    const res = await fetch(`${baseUrl}/api/eval/runs/${run.id}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(run);
  });

  it("returns 404 when the run does not exist", async () => {
    vi.mocked(getEvalRun).mockRejectedValue(new EvalRunNotFoundError("missing"));

    const res = await fetch(`${baseUrl}/api/eval/runs/missing`);

    expect(res.status).toBe(404);
  });
});

describe("POST /api/eval/runs/:id/stop", () => {
  it("stops an active run", async () => {
    vi.mocked(requestStop).mockReturnValue(true);

    const res = await fetch(`${baseUrl}/api/eval/runs/some-id/stop`, { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ stopped: true });
    expect(requestStop).toHaveBeenCalledWith("some-id");
  });

  it("returns 404 when the run is not active", async () => {
    vi.mocked(requestStop).mockReturnValue(false);

    const res = await fetch(`${baseUrl}/api/eval/runs/some-id/stop`, { method: "POST" });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/eval/runs/:id/stream", () => {
  it("immediately emits a done event and closes for a finished run", async () => {
    const run = { ...summary(), status: "completed", result: [], error: null };
    vi.mocked(getEvalRun).mockResolvedValue(run as never);

    const res = await fetch(`${baseUrl}/api/eval/runs/${run.id}/stream`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"type":"done"');
  });

  it("returns 404 for an unknown run", async () => {
    vi.mocked(getEvalRun).mockRejectedValue(new EvalRunNotFoundError("missing"));

    const res = await fetch(`${baseUrl}/api/eval/runs/missing/stream`);

    expect(res.status).toBe(404);
  });
});
