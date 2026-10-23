import {
  EvalRunSummarySchema,
  EvalRunDetailSchema,
  EvalProgressEventSchema,
} from "@wingman/shared";
import type {
  EvalTrack,
  EvalRunConfig,
  EvalRunSummary,
  EvalRunDetail,
  EvalProgressEvent,
} from "@wingman/shared";

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function startRun(
  track: EvalTrack,
  config: Partial<EvalRunConfig>
): Promise<EvalRunSummary> {
  const res = await fetch("/api/eval/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ track, config }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not start the run."));
  return EvalRunSummarySchema.parse(await res.json());
}

export async function listRuns(track?: EvalTrack): Promise<EvalRunSummary[]> {
  const url = track !== undefined ? `/api/eval/runs?track=${track}` : "/api/eval/runs";
  const res = await fetch(url);
  if (!res.ok) throw new Error(await readError(res, "Could not load run history."));
  return EvalRunSummarySchema.array().parse(await res.json());
}

export async function getRun(id: string): Promise<EvalRunDetail> {
  const res = await fetch(`/api/eval/runs/${id}`);
  if (!res.ok) throw new Error(await readError(res, "Could not load that run."));
  return EvalRunDetailSchema.parse(await res.json());
}

export async function stopRun(id: string): Promise<void> {
  const res = await fetch(`/api/eval/runs/${id}/stop`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "Could not stop the run."));
}

// Live progress for one run (issue #250). Returns an unsubscribe function.
// `onEvent` is only ever called with a schema-valid event; a dropped
// connection or a malformed payload is logged rather than silently ignored,
// since either would otherwise leave the live view frozen with no
// explanation (the run itself is unaffected — only this stream is best-effort).
export function subscribeToRun(
  id: string,
  onEvent: (event: EvalProgressEvent) => void
): () => void {
  const source = new EventSource(`/api/eval/runs/${id}/stream`);
  source.onmessage = (message) => {
    const parsed = EvalProgressEventSchema.safeParse(JSON.parse(message.data));
    if (parsed.success) {
      onEvent(parsed.data);
    } else {
      console.warn("subscribeToRun: dropped a malformed progress event", parsed.error);
    }
  };
  source.onerror = () => {
    console.warn(`subscribeToRun: SSE connection error for run ${id}`);
  };
  return () => source.close();
}
