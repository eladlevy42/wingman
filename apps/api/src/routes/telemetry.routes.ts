import { Router } from "express";
import { TelemetryBatchSchema } from "@wingman/shared";
import { recordTelemetryBatch } from "../services/telemetry.service";
import { positiveIntFromEnv, rateLimit } from "../middleware/rateLimit";

export const telemetryRouter = Router();

// Both configurable so a load test or a demo can loosen them without a code
// change, and both fall back rather than throwing on a malformed value (#381).
const TELEMETRY_RATE_LIMIT = positiveIntFromEnv("TELEMETRY_RATE_LIMIT", 60);
const TELEMETRY_RATE_WINDOW_MS = positiveIntFromEnv("TELEMETRY_RATE_WINDOW_MS", 60_000);

telemetryRouter.post(
  "/",
  rateLimit({ limit: TELEMETRY_RATE_LIMIT, windowMs: TELEMETRY_RATE_WINDOW_MS }),
  async (req, res) => {
    const parsed = TelemetryBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      // Includes an over-cap batch: rejected outright rather than truncated,
      // so a client that is sending too much finds out (#554).
      res.status(400).json({ error: "Invalid telemetry batch" });
      return;
    }

    try {
      res.json(await recordTelemetryBatch(parsed.data));
    } catch (err) {
      console.error("POST /api/telemetry failed:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
