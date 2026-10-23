import type { EvalRunConfig, Track2LogRecord } from "@wingman/shared";

export interface EvalCaseProgress {
  index: number;
  total: number;
  costUsd: number;
  durationMs: number;
  // Normalized 0-1 — see EvalProgressEventSchema's "case" variant in
  // packages/shared for why this exists ahead of the full per-case result.
  score: number;
  summary: string;
}

// Threaded into each track runner so it can respect a run's config (subset
// size, model tier, seed), report per-case progress for the live SSE view,
// and stop early on cancellation or a blown budget cap. See issue #250.
export interface EvalRunContext {
  config: EvalRunConfig;
  shouldStop: () => boolean;
  onCase: (progress: EvalCaseProgress) => void;
  // Optional per-record sink (issue #420). Track 2 calls this as each couple's
  // log record is built, so a caller can flush partial evidence to disk before
  // the whole run finishes — a mid-run crash (e.g. an exhausted rate limit)
  // then leaves the completed couples on disk instead of nothing. Awaited so a
  // slow write can't race the next couple's negotiation.
  onRecord?: (record: Track2LogRecord) => void | Promise<void>;
}
