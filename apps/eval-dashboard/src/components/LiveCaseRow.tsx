import { cn } from "@/lib/utils";

export interface LiveCase {
  index: number;
  total: number;
  costUsd: number;
  durationMs: number;
  score: number;
  summary: string;
}

// A lightweight, non-expandable row for a case that just finished mid-run —
// full per-case detail (transcript, field table) isn't available yet, only
// the SSE progress event's summary. Once the run completes, App.tsx swaps
// these for full CaseCard accordions built from the persisted result.
export function LiveCaseRow({ liveCase, threshold }: { liveCase: LiveCase; threshold: number }) {
  const passed = liveCase.score >= threshold;
  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-lg border p-3",
        passed ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10"
      )}
      data-testid={passed ? "live-case-pass" : "live-case-fail"}
    >
      <div>
        <p className="text-sm font-medium text-foreground">
          Case {liveCase.index} of {liveCase.total}
        </p>
        <p className="text-xs text-muted-foreground">{liveCase.summary}</p>
      </div>
      <div className="flex items-center gap-4 text-right">
        <div>
          <p className="text-xs text-muted-foreground">cost</p>
          <p className="text-sm tabular-nums text-foreground">${liveCase.costUsd.toFixed(4)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">time</p>
          <p className="text-sm tabular-nums text-foreground">
            {(liveCase.durationMs / 1000).toFixed(1)}s
          </p>
        </div>
      </div>
    </div>
  );
}
