import { Router } from "express";
import { ZodError } from "zod";
import { TriggerMatchSchema, DecideMatchSchema, SubmitAvailabilitySchema } from "@wingman/shared";
import { negotiateAndPersist } from "../services/negotiation.service";
import { decideMatch, MatchNotFoundError, MatchOwnershipError } from "../services/match.service";
import { resolveMatchById } from "../services/decision.service";
import { isOrchestrationRunning } from "../services/orchestration.service";
import {
  submitAvailability,
  SlotNotOfferedError,
  MatchNotChoosingTimesError,
} from "../services/scheduling.service";

export const matchRouter = Router();

matchRouter.post("/negotiate", async (req, res) => {
  try {
    const { userAId, userBId } = TriggerMatchSchema.parse(req.body);
    const match = await negotiateAndPersist(userAId, userBId);
    res.json(match);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    // loadParticipant throws both "... not found" (nonexistent user id) and
    // "... has no completed profile" (real user, incomplete/missing
    // Profile/WantedProfile) — both are expected 4xx validation failures, not
    // server errors, so both must be caught here (#408).
    if (err instanceof Error && /not found|no completed profile/.test(err.message)) {
      res.status(404).json({ error: err.message });
      return;
    }
    // Log before the opaque 500 — a negotiation/agent failure would
    // otherwise vanish without a trace.
    console.error("POST /api/match/negotiate failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

matchRouter.post("/decide", async (req, res) => {
  try {
    const { matchId, userId, decision } = DecideMatchSchema.parse(req.body);
    const result = await decideMatch(matchId, userId, decision);
    // Resolve immediately so the second "yeah" opens the choose-times step (and
    // a "nah" rejects) without waiting for the next resolver sweep. The decision
    // is already committed above, so a resolution failure is logged, not fatal.
    try {
      await resolveMatchById(matchId);
    } catch (resolveErr) {
      console.error(`POST /api/match/decide: resolve failed for ${matchId}:`, resolveErr);
    }
    res.json(result);
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
    console.error("POST /api/match/decide failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

matchRouter.post("/availability", async (req, res) => {
  try {
    const { matchId, userId, slots } = SubmitAvailabilitySchema.parse(req.body);
    const result = await submitAvailability(matchId, userId, slots);
    res.json(result);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    if (err instanceof SlotNotOfferedError) {
      res.status(400).json({ error: "One or more selected times are not on offer" });
      return;
    }
    if (err instanceof MatchOwnershipError) {
      res.status(403).json({ error: "User is not a participant in this match" });
      return;
    }
    if (err instanceof MatchNotChoosingTimesError) {
      res.status(409).json({ error: "This match is not choosing times" });
      return;
    }
    console.error("POST /api/match/availability failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Whether a match cycle/sweep currently holds the orchestration lock (#361) —
// lets the Waiting page show honest "Barney is negotiating" progress after a
// manual trigger, and detect when the background cycle finished.
matchRouter.get("/orchestration-status", (_req, res) => {
  res.json({ running: isOrchestrationRunning() });
});
