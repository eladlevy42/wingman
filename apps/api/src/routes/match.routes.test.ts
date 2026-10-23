import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../services/negotiation.service", () => ({
  negotiateAndPersist: vi.fn(),
}));
vi.mock("../services/match.service", () => ({
  decideMatch: vi.fn(),
  MatchNotFoundError: class MatchNotFoundError extends Error {},
  MatchOwnershipError: class MatchOwnershipError extends Error {},
}));
vi.mock("../services/decision.service", () => ({
  resolveMatchById: vi.fn(),
}));
vi.mock("../services/orchestration.service", () => ({
  isOrchestrationRunning: vi.fn(),
}));
vi.mock("../services/scheduling.service", () => ({
  submitAvailability: vi.fn(),
  SlotNotOfferedError: class SlotNotOfferedError extends Error {},
  MatchNotChoosingTimesError: class MatchNotChoosingTimesError extends Error {},
}));

import { matchRouter } from "./match.routes";
import { negotiateAndPersist } from "../services/negotiation.service";

// zod's uuid() only checks the 8-4-4-4-12 hex shape, not RFC version/variant
// nibbles, so plain hex-padded ids are valid without pulling in a uuid lib.
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const userA = uuid(1);
const userB = uuid(2);
const missingUser = uuid(3);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/match", matchRouter);
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

describe("POST /api/match/negotiate", () => {
  it("returns 404 when a participant has no completed profile (#408)", async () => {
    vi.mocked(negotiateAndPersist).mockRejectedValue(
      new Error(`negotiateAndPersist: user ${userB} has no completed profile`)
    );

    const res = await fetch(`${baseUrl}/api/match/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAId: userA, userBId: userB }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: `negotiateAndPersist: user ${userB} has no completed profile`,
    });
  });

  it("still returns 404 for a genuinely nonexistent user id (no regression)", async () => {
    vi.mocked(negotiateAndPersist).mockRejectedValue(
      new Error(`negotiateAndPersist: user ${missingUser} not found`)
    );

    const res = await fetch(`${baseUrl}/api/match/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAId: missingUser, userBId: userB }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: `negotiateAndPersist: user ${missingUser} not found`,
    });
  });

  it("returns 500 for a genuinely unexpected error", async () => {
    vi.mocked(negotiateAndPersist).mockRejectedValue(new Error("boom"));

    const res = await fetch(`${baseUrl}/api/match/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAId: userA, userBId: userB }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
  });

  it("returns 400 on malformed input", async () => {
    const res = await fetch(`${baseUrl}/api/match/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAId: userA }),
    });

    expect(res.status).toBe(400);
    expect(negotiateAndPersist).not.toHaveBeenCalled();
  });
});
