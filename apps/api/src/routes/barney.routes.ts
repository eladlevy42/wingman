import { Router } from "express";
import { ZodError } from "zod";
import type { BarneyStreamEvent } from "@wingman/shared";
import { AgentAuthError, AgentSdkUnavailableError } from "../agents/agentSdkClient";
import {
  changeLanguage,
  createSession,
  sendMessage,
  streamMessage,
  SessionNotFoundError,
  MatchNotFoundError,
  MatchOwnershipError,
} from "../services/barney.service";

export const barneyRouter = Router();

// A failed Agent SDK call (bad/expired auth, or the `claude` CLI subprocess
// itself failing to start — see agentSdkClient's AgentAuthError /
// AgentSdkUnavailableError, and docs/adr/0011's Update for issue #410) is not
// a bug in the request or in this server's own logic — it is the AI backend
// being unreachable. Surfacing it as a generic 500 makes it indistinguishable
// from a genuine server bug, which is exactly what #410 reported. 503 +
// "AI service temporarily unavailable" gives the client (and whoever's
// debugging) an actionable, distinct signal instead.
function isAgentSdkFailure(err: unknown): boolean {
  return err instanceof AgentAuthError || err instanceof AgentSdkUnavailableError;
}

const AGENT_SDK_UNAVAILABLE_RESPONSE = {
  error: "AI service temporarily unavailable. Please try again shortly.",
};

barneyRouter.post("/session", async (req, res) => {
  try {
    const result = await createSession(req.body);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    if (err instanceof MatchNotFoundError) {
      res.status(404).json({ error: "Match not found" });
      return;
    }
    if (err instanceof MatchOwnershipError) {
      res.status(403).json({ error: "User is not a participant in this match" });
      return;
    }
    if (isAgentSdkFailure(err)) {
      console.error("POST /api/barney/session failed — Agent SDK unavailable:", err);
      res.status(503).json(AGENT_SDK_UNAVAILABLE_RESPONSE);
      return;
    }
    // Log before the opaque 500 — a failed agent init (e.g. missing
    // ANTHROPIC_API_KEY) would otherwise vanish without a trace.
    console.error("POST /api/barney/session failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

barneyRouter.post("/message", async (req, res) => {
  try {
    const result = await sendMessage(req.body);
    res.json(result);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    if (err instanceof SessionNotFoundError) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (isAgentSdkFailure(err)) {
      console.error("POST /api/barney/message failed — Agent SDK unavailable:", err);
      res.status(503).json(AGENT_SDK_UNAVAILABLE_RESPONSE);
      return;
    }
    // Log before the opaque 500 — an agent runtime error (API failure, etc.)
    // would otherwise vanish without a trace.
    console.error("POST /api/barney/message failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// The mid-interview language toggle (ADR-0037): switches the session and
// returns the pending question restated in the new language. Never calls the
// model, so there is no Agent SDK failure to map.
barneyRouter.post("/language", async (req, res) => {
  try {
    const result = await changeLanguage(req.body);
    res.json(result);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    if (err instanceof SessionNotFoundError) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    console.error("POST /api/barney/language failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Streaming counterpart of /message (server-sent events). Emits the same turn's
// reply as a word-by-word stream; the client falls back to /message if this is
// unavailable. Because the turn is validated inside streamMessage (via
// sendMessage), a bad request surfaces as an SSE `error` event rather than an
// HTTP status — the stream headers are already committed by then.
barneyRouter.post("/message/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Defeat proxy buffering (nginx and Vite's dev proxy) so events flush live.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const write = (event: BarneyStreamEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    for await (const event of streamMessage(req.body)) {
      write(event);
    }
  } catch (err) {
    if (err instanceof ZodError) {
      write({ type: "error", message: "Invalid request" });
    } else if (err instanceof SessionNotFoundError) {
      write({ type: "error", message: "Session not found" });
    } else if (isAgentSdkFailure(err)) {
      console.error("POST /api/barney/message/stream failed — Agent SDK unavailable:", err);
      write({ type: "error", message: AGENT_SDK_UNAVAILABLE_RESPONSE.error });
    } else {
      console.error("POST /api/barney/message/stream failed:", err);
      write({ type: "error", message: "Internal server error" });
    }
  } finally {
    res.end();
  }
});
