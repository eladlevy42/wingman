import { Router } from "express";
import { getAgentCosts, getUserTimeline } from "../services/auditRead.service";

export const auditRouter = Router();

// Dev/audit surfaces, following the /api/match-attempts precedent (#253): the
// route is open, the PAGE is dev-gated. Nothing here can leak content, because
// neither audit table stores any (docs/adr/0038).

// One user's events with the agent calls each caused.
auditRouter.get("/timeline/:userId", async (req, res) => {
  try {
    res.json(await getUserTimeline(req.params.userId));
  } catch (err) {
    console.error(`GET /api/audit/timeline/${req.params.userId} failed:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent spend by day, actor and model. Defaults to the last 30 days; a
// malformed date falls back to that default rather than 400-ing a dev page.
auditRouter.get("/costs", async (req, res) => {
  try {
    const to = parseDate(req.query.to, new Date());
    const from = parseDate(req.query.from, defaultFrom(to));
    res.json(await getAgentCosts(from, to));
  } catch (err) {
    console.error("GET /api/audit/costs failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const DEFAULT_RANGE_DAYS = 30;

function defaultFrom(to: Date): Date {
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - DEFAULT_RANGE_DAYS);
  from.setUTCHours(0, 0, 0, 0);
  return from;
}

function parseDate(raw: unknown, fallback: Date): Date {
  if (typeof raw !== "string") return fallback;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}
