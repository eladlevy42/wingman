import { Router } from "express";
import { ZodError } from "zod";
import { EvalTrackParamSchema, EvalStartRunRequestSchema } from "@wingman/shared";
import { EvalPreconditionError } from "../services/eval/track1.service";
import {
  startEvalRun,
  listEvalRuns,
  getEvalRun,
  EvalRunNotFoundError,
} from "../services/eval/evalRun.service";
import { getActiveRun, requestStop } from "../services/eval/runRegistry";

export const evalRouter = Router();

// Starts a track run in the background — issue #250. Responds as soon as the
// EvalRun row is created (status "running"); the client follows progress via
// GET /runs/:id/stream and the final result via GET /runs/:id.
evalRouter.post("/runs", async (req, res) => {
  let body;
  try {
    body = EvalStartRunRequestSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid run request", issues: err.issues });
      return;
    }
    throw err;
  }

  try {
    const run = await startEvalRun(body.track, body.config);
    res.status(201).json(run);
  } catch (err) {
    if (err instanceof EvalPreconditionError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error(`POST /api/eval/runs failed:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

evalRouter.get("/runs", async (req, res) => {
  let track;
  if (req.query.track !== undefined) {
    try {
      track = EvalTrackParamSchema.parse(req.query.track);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: "Invalid track — must be 1, 2, or 3" });
        return;
      }
      throw err;
    }
  }
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;

  try {
    const runs = await listEvalRuns(track, Number.isFinite(limit) ? limit : undefined);
    res.json(runs);
  } catch (err) {
    console.error(`GET /api/eval/runs failed:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

evalRouter.get("/runs/:id", async (req, res) => {
  try {
    const run = await getEvalRun(req.params.id);
    res.json(run);
  } catch (err) {
    if (err instanceof EvalRunNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error(`GET /api/eval/runs/${req.params.id} failed:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Live progress for one run, issue #250. If the run has already finished by
// the time a client subscribes, immediately emits a single terminal event
// from the persisted row and closes — there is no backlog of "case" events to
// replay, only the outcome.
evalRouter.get("/runs/:id/stream", async (req, res) => {
  const runId = req.params.id;

  let run;
  try {
    run = await getEvalRun(runId);
  } catch (err) {
    if (err instanceof EvalRunNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error(`GET /api/eval/runs/${runId}/stream failed:`, err);
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (run.status !== "running") {
    send(
      run.status === "failed"
        ? { type: "error", message: run.error ?? "Eval run failed" }
        : { type: run.status === "stopped" ? "stopped" : "done", run }
    );
    res.end();
    return;
  }

  const active = getActiveRun(runId);
  if (!active) {
    // Row says "running" but the process isn't tracking it (orphaned by a
    // server restart mid-run, see runRegistry.ts) — nothing will ever move
    // this run forward, so report it as failed rather than hanging forever.
    send({ type: "error", message: "This run is no longer active (server restarted mid-run)." });
    res.end();
    return;
  }

  const onEvent = (event: { type: string }) => {
    send(event);
    if (event.type !== "case") {
      res.end();
    }
  };
  active.emitter.on("event", onEvent);

  req.on("close", () => {
    active.emitter.off("event", onEvent);
  });
});

evalRouter.post("/runs/:id/stop", (req, res) => {
  const stopped = requestStop(req.params.id);
  if (!stopped) {
    res.status(404).json({ error: `No active eval run with id ${req.params.id}` });
    return;
  }
  res.json({ stopped: true });
});
