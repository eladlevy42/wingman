import { prisma } from "@wingman/database";
import type { EvalRun } from "@wingman/database";
import {
  EvalRunConfigSchema,
  EvalRunSummarySchema,
  EvalRunDetailSchema,
  type EvalTrack,
  type EvalRunConfig,
  type EvalRunSummary,
  type EvalRunDetail,
  type EvalResult,
  type Track2LogRecord,
  type Track2RunLog,
} from "@wingman/shared";
import { TOTAL_TURNS } from "../../agents/negotiation.agent";
import { runTrack1 } from "./track1.service";
import { runTrack2 } from "./track2.service";
import { runTrack3 } from "./track3.service";
import { registerRun, unregisterRun } from "./runRegistry";
import { writeTrack2Log } from "./track2Log";
import type { EvalRunContext } from "./types";

export class EvalRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No eval run found with id ${runId}`);
    this.name = "EvalRunNotFoundError";
  }
}

type TrackRunner = (ctx: EvalRunContext) => Promise<EvalResult>;

// Track 2's runner also emits per-couple log records (issue #420), but the app
// path captures them incrementally via ctx.onRecord (see startEvalRun) rather
// than from this return value — so a stopped or crashed run keeps the couples
// already done. Here we only need the run's EvalResult.
const trackRunners: Record<EvalTrack, TrackRunner> = {
  1: runTrack1 as TrackRunner,
  2: (async (ctx) => (await runTrack2(ctx)).result) as TrackRunner,
  3: runTrack3 as TrackRunner,
};

function toSummary(row: EvalRun): EvalRunSummary {
  return EvalRunSummarySchema.parse({
    id: row.id,
    track: row.track,
    status: row.status,
    config: JSON.parse(row.config),
    costUsd: row.costUsd,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toDetail(row: EvalRun): EvalRunDetail {
  return EvalRunDetailSchema.parse({
    ...toSummary(row),
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
  });
}

// Starts a track run in the background and returns immediately with the new
// row's id/status ("running") — the caller follows progress via
// GET /api/eval/runs/:id/stream (SSE) and full results via
// getEvalRun(id). See issue #250. A track precondition failure (e.g. Track 1's
// 500-WAITING-users requirement) surfaces asynchronously as status "failed"
// with `error` set, not as an immediate rejection — the run is already
// "in flight" from the caller's perspective the moment this resolves.
export async function startEvalRun(
  track: EvalTrack,
  configInput: Partial<EvalRunConfig> = {}
): Promise<EvalRunSummary> {
  const config = EvalRunConfigSchema.parse(configInput);

  const row = await prisma.evalRun.create({
    data: { track, status: "running", config: JSON.stringify(config) },
  });

  const active = registerRun(row.id);
  const startedAt = Date.now();
  let totalCostUsd = 0;

  // Track 2 crash-safe evidence log (issue #420). Couples accumulate here via
  // ctx.onRecord as each one finishes and are flushed to a stable per-run file,
  // so a stopped or crashed run keeps the couples already completed instead of
  // losing the whole log. Other tracks never call onRecord, so this stays empty.
  const track2Records: Track2LogRecord[] = [];
  const track2FileStamp = new Date(startedAt).toISOString();
  const writeTrack2LogIfAny = async (costUsd: number): Promise<void> => {
    if (track !== 2 || track2Records.length === 0) return;
    try {
      const log: Track2RunLog = {
        meta: {
          startedAtIso: track2FileStamp,
          barneyModel: config.barneyModel,
          judgeModel: config.judgeModel,
          // turns has no schema default (unlike barney/judgeModel) — fall back
          // to the negotiation module's own default (TOTAL_TURNS = 8), the same
          // value runNegotiation uses when turns is unset.
          turns: config.turns ?? TOTAL_TURNS,
          seed: config.seed,
          costUsd,
          durationMs: Date.now() - startedAt,
          // Hoisted so the guard's false-positive rate is auditable from meta
          // alone (issue #422).
          guardRetryCount: track2Records.reduce((n, r) => n + r.guardRetries.length, 0),
        },
        records: track2Records,
      };
      // Reuse the stable stamp so every incremental flush and the final write
      // target the same file; the partial is overwritten with complete records
      // and the real cost at the end.
      const path = await writeTrack2Log(log, track2FileStamp);
      console.log(`Track 2 run log written to ${path}`);
    } catch (err) {
      // Supplementary evidence, never the run's source of truth (the EvalRun
      // row is) — a write failure must not fail an otherwise-successful run.
      console.error("Failed to write Track 2 run log:", err);
    }
  };

  void (async () => {
    try {
      const runner = trackRunners[track];
      const result = await runner({
        config,
        shouldStop: () => active.cancelled,
        onCase: ({ index, total, costUsd, durationMs, score, summary }) => {
          totalCostUsd += costUsd;
          if (config.budgetCapUsd !== undefined && totalCostUsd >= config.budgetCapUsd) {
            active.cancelled = true;
          }
          active.emitter.emit("event", {
            type: "case",
            index,
            total,
            caseCostUsd: costUsd,
            caseDurationMs: durationMs,
            totalCostUsd,
            elapsedMs: Date.now() - startedAt,
            score,
            summary,
          });
        },
        // Flush each couple's audit record as it completes (issue #420) so an
        // interrupted run leaves finished couples on disk. Partial writes carry
        // costUsd 0; the final write below corrects it. Awaited so a slow write
        // can't race the next couple's negotiation.
        onRecord: async (record) => {
          track2Records.push(record);
          await writeTrack2LogIfAny(0);
        },
      });

      const status = active.cancelled ? "stopped" : "completed";
      const durationMs = Date.now() - startedAt;
      const updated = await prisma.evalRun.update({
        where: { id: row.id },
        data: {
          status,
          result: JSON.stringify(result),
          costUsd: totalCostUsd,
          durationMs,
        },
      });

      // Final Track 2 log write with the real total cost. Runs for a stopped
      // run too (not just "completed") — a cancelled or budget-capped run still
      // has evidence worth keeping (issue #420).
      await writeTrack2LogIfAny(totalCostUsd);

      active.emitter.emit("event", {
        type: status === "stopped" ? "stopped" : "done",
        run: toDetail(updated),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown eval run error";
      // Preserve whatever Track 2 couples finished before the crash, tagged with
      // the cost accrued so far (issue #420). The per-couple flushes already
      // wrote them; this refreshes the file with the accurate partial cost.
      await writeTrack2LogIfAny(totalCostUsd);
      await prisma.evalRun.update({
        where: { id: row.id },
        data: {
          status: "failed",
          error: message,
          costUsd: totalCostUsd,
          durationMs: Date.now() - startedAt,
        },
      });
      active.emitter.emit("event", { type: "error", message });
    } finally {
      unregisterRun(row.id);
    }
  })();

  return toSummary(row);
}

export async function listEvalRuns(track?: EvalTrack, limit = 50): Promise<EvalRunSummary[]> {
  const rows = await prisma.evalRun.findMany({
    where: track !== undefined ? { track } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toSummary);
}

export async function getEvalRun(runId: string): Promise<EvalRunDetail> {
  const row = await prisma.evalRun.findUnique({ where: { id: runId } });
  if (!row) throw new EvalRunNotFoundError(runId);
  return toDetail(row);
}
