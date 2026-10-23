import { Router } from "express";
import {
  listMatchAttempts,
  getMatchAttempt,
  MatchAttemptNotFoundError,
} from "../services/matchAttempt.service";

export const matchAttemptRouter = Router();

// History list (issue #253) — optionally scoped to one user via ?userId=.
matchAttemptRouter.get("/", async (req, res) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
  try {
    const attempts = await listMatchAttempts(userId);
    res.json(attempts);
  } catch (err) {
    console.error("GET /api/match-attempts failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Full pipeline detail for one attempt — the dev page polls this while
// status is "RUNNING" for the live view.
matchAttemptRouter.get("/:id", async (req, res) => {
  try {
    const attempt = await getMatchAttempt(req.params.id);
    res.json(attempt);
  } catch (err) {
    if (err instanceof MatchAttemptNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error(`GET /api/match-attempts/${req.params.id} failed:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});
