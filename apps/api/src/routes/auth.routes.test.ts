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

import { app } from "../app";

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

describe("auth routes after social sign-in was removed (#512)", () => {
  it("no longer serves POST /api/auth/social-login", async () => {
    // Pinned rather than assumed. Deleting a route leaves nothing behind that
    // fails when it comes back — and the reason it went is that it could not
    // be reached from either client, which is exactly the kind of thing that
    // gets re-added by accident.
    const res = await fetch(`${baseUrl}/api/auth/social-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "anything" }),
    });

    expect(res.status).toBe(404);
  });

  it("still serves the two routes that are left", async () => {
    // Both reject an empty body, which is enough to prove the handler is
    // mounted without reaching for the database.
    for (const path of ["/api/auth/register", "/api/auth/login"]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status, path).toBe(400);
    }
  });
});
