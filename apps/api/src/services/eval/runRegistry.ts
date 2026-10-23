import { EventEmitter } from "node:events";
import type { EvalProgressEvent } from "@wingman/shared";

interface ActiveRunEvents {
  event: [EvalProgressEvent];
}

export interface ActiveRun {
  cancelled: boolean;
  emitter: EventEmitter<ActiveRunEvents>;
}

// In-memory registry of in-flight eval runs, keyed by EvalRun.id — backs the
// Run/Stop button and the live SSE view (issue #250). Deliberately not
// persisted: if the API process restarts mid-run, the run is orphaned (its DB
// row stays "running" forever, same as a crash today would leave it); a fresh
// GET /api/eval/runs/:id/stream for that id just finds no active entry and
// falls back to reading the row as-is. Acceptable for a dev-only eval tool.
const activeRuns = new Map<string, ActiveRun>();

export function registerRun(runId: string): ActiveRun {
  const run: ActiveRun = { cancelled: false, emitter: new EventEmitter() };
  activeRuns.set(runId, run);
  return run;
}

export function getActiveRun(runId: string): ActiveRun | undefined {
  return activeRuns.get(runId);
}

// Returns true if a live run was found and flagged to stop, false if the run
// isn't active (already finished, or never existed).
export function requestStop(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (!run) return false;
  run.cancelled = true;
  return true;
}

export function unregisterRun(runId: string): void {
  activeRuns.delete(runId);
}
