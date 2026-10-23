import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@wingman/database", () => ({
  prisma: {
    user: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import { app } from "./app";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("app (real Express stack)", () => {
  it("returns a JSON 400 for a malformed-JSON body on POST /api/auth/register", async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("returns a JSON 400 for a malformed-JSON body on POST /api/auth/login", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });
});
