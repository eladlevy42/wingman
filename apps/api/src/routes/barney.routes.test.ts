import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Issue #410: a failed Agent SDK call (bad auth, or the `claude` CLI
// subprocess itself failing to start) must not surface as the same opaque 500
// as any other unexpected server error. These tests simulate the service
// layer throwing the two Agent SDK failure types and assert the route
// responds with a distinct, actionable 503 instead.
vi.mock("../services/barney.service", () => ({
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  streamMessage: vi.fn(),
  SessionNotFoundError: class SessionNotFoundError extends Error {},
  MatchNotFoundError: class MatchNotFoundError extends Error {},
  MatchOwnershipError: class MatchOwnershipError extends Error {},
}));

import { barneyRouter } from "./barney.routes";
import {
  createSession,
  sendMessage,
  streamMessage,
  SessionNotFoundError,
} from "../services/barney.service";
import { AgentAuthError, AgentSdkUnavailableError } from "../agents/agentSdkClient";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/barney", barneyRouter);
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

describe("POST /api/barney/session", () => {
  it("returns a distinct 503 on AgentAuthError instead of an opaque 500", async () => {
    vi.mocked(createSession).mockRejectedValue(new AgentAuthError("authentication_failed"));

    const res = await fetch(`${baseUrl}/api/barney/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("returns a distinct 503 on AgentSdkUnavailableError instead of an opaque 500", async () => {
    vi.mocked(createSession).mockRejectedValue(
      new AgentSdkUnavailableError("Claude Code process exited with code 1")
    );

    const res = await fetch(`${baseUrl}/api/barney/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("still returns a generic 500 for an unrelated error", async () => {
    vi.mocked(createSession).mockRejectedValue(new Error("db connection lost"));

    const res = await fetch(`${baseUrl}/api/barney/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Internal server error");
  });
});

describe("POST /api/barney/message", () => {
  it("returns a distinct 503 on AgentSdkUnavailableError instead of an opaque 500", async () => {
    vi.mocked(sendMessage).mockRejectedValue(
      new AgentSdkUnavailableError("Claude Code process exited with code 1")
    );

    const res = await fetch(`${baseUrl}/api/barney/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi" }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("still returns a generic 500 for an unrelated error", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("boom"));

    const res = await fetch(`${baseUrl}/api/barney/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi" }),
    });

    expect(res.status).toBe(500);
  });
});

describe("POST /api/barney/message/stream", () => {
  it("emits a distinct error event on AgentSdkUnavailableError instead of a generic one", async () => {
    vi.mocked(streamMessage).mockImplementation(
      // This generator only ever throws — the mocked signature requires a generator function shape.
      // eslint-disable-next-line require-yield
      async function* () {
        throw new AgentSdkUnavailableError("Claude Code process exited with code 1");
      }
    );

    const res = await fetch(`${baseUrl}/api/barney/message/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi" }),
    });

    const text = await res.text();
    expect(text).toMatch(/temporarily unavailable/i);
  });
});

/**
 * #496: the mobile client decides a resumed conversation is dead by matching
 * this exact string, and only then does it clear the snapshot and start a fresh
 * interview. A copy edit here would silently disable that recovery — the user
 * would sit in a restored transcript getting an opaque error on every answer.
 * Both routes must keep saying it, verbatim.
 *
 * If this string ever has to change, `isSessionLost` in
 * apps/mobile/hooks/useBarneyChat.ts changes with it.
 */
describe("session-not-found wording (relied on by the mobile resume path, #496)", () => {
  it("POST /api/barney/message answers 404 with the exact string", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new SessionNotFoundError("nope"));

    const res = await fetch(`${baseUrl}/api/barney/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("POST /api/barney/message/stream writes the same string as an error event", async () => {
    vi.mocked(streamMessage).mockImplementation(
      // This generator only ever throws — the mocked signature requires a generator function shape.
      // eslint-disable-next-line require-yield
      async function* () {
        throw new SessionNotFoundError("nope");
      }
    );

    const res = await fetch(`${baseUrl}/api/barney/message/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi" }),
    });

    expect(await res.text()).toContain('"message":"Session not found"');
  });
});
