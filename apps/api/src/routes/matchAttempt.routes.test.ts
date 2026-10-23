import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../services/matchAttempt.service", () => ({
  listMatchAttempts: vi.fn(),
  getMatchAttempt: vi.fn(),
  MatchAttemptNotFoundError: class MatchAttemptNotFoundError extends Error {},
}));

import { matchAttemptRouter } from "./matchAttempt.routes";
import {
  listMatchAttempts,
  getMatchAttempt,
  MatchAttemptNotFoundError,
} from "../services/matchAttempt.service";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/match-attempts", matchAttemptRouter);
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

describe("GET /api/match-attempts", () => {
  it("returns the attempt history", async () => {
    const attempts = [{ id: "attempt-1", status: "MATCHED" }];
    vi.mocked(listMatchAttempts).mockResolvedValue(attempts as never);

    const res = await fetch(`${baseUrl}/api/match-attempts`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(attempts);
    expect(listMatchAttempts).toHaveBeenCalledWith(undefined);
  });

  it("passes a userId query param through", async () => {
    vi.mocked(listMatchAttempts).mockResolvedValue([]);

    await fetch(`${baseUrl}/api/match-attempts?userId=user-1`);

    expect(listMatchAttempts).toHaveBeenCalledWith("user-1");
  });

  it("returns 500 on an unexpected error", async () => {
    vi.mocked(listMatchAttempts).mockRejectedValue(new Error("boom"));

    const res = await fetch(`${baseUrl}/api/match-attempts`);

    expect(res.status).toBe(500);
  });
});

describe("GET /api/match-attempts/:id", () => {
  it("returns the attempt detail", async () => {
    const attempt = { id: "attempt-1", status: "RUNNING", candidateScores: [], negotiations: [] };
    vi.mocked(getMatchAttempt).mockResolvedValue(attempt as never);

    const res = await fetch(`${baseUrl}/api/match-attempts/attempt-1`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(attempt);
  });

  it("returns 404 when the attempt does not exist", async () => {
    vi.mocked(getMatchAttempt).mockRejectedValue(new MatchAttemptNotFoundError("missing"));

    const res = await fetch(`${baseUrl}/api/match-attempts/missing`);

    expect(res.status).toBe(404);
  });
});
