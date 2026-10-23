import type { EvalRunSummary } from "@wingman/shared";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<EvalRunSummary["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

const STATUS_CLASS: Record<EvalRunSummary["status"], string> = {
  running: "text-secondary",
  completed: "text-success",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

export interface HistorySidebarProps {
  runs: EvalRunSummary[];
  loading: boolean;
  selectedRunId: string | null;
  diffPicks: string[];
  onSelect: (id: string) => void;
  onToggleDiffPick: (id: string) => void;
}

// Sidebar listing past runs for this track (issue #250) — click a row to
// reopen its full results; check up to two rows to diff them side by side.
export function HistorySidebar({
  runs,
  loading,
  selectedRunId,
  diffPicks,
  onSelect,
  onToggleDiffPick,
}: HistorySidebarProps) {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto" aria-label="Run history">
      <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        History
      </p>
      {loading && <p className="px-1 text-sm text-muted-foreground">Loading…</p>}
      {!loading && runs.length === 0 && (
        <p className="px-1 text-sm text-muted-foreground">No runs yet for this track.</p>
      )}
      {runs.map((run) => (
        <div
          key={run.id}
          className={cn(
            "flex items-start gap-2 rounded-lg border p-2 text-left transition-colors",
            selectedRunId === run.id ? "border-primary bg-accent" : "border-border hover:bg-accent"
          )}
        >
          <input
            type="checkbox"
            aria-label={`Select run ${run.id} for diff`}
            className="mt-1"
            checked={diffPicks.includes(run.id)}
            disabled={!diffPicks.includes(run.id) && diffPicks.length >= 2}
            onChange={() => onToggleDiffPick(run.id)}
          />
          <button type="button" className="flex-1 text-left" onClick={() => onSelect(run.id)}>
            <p className="text-xs text-muted-foreground">
              {new Date(run.createdAt).toLocaleString()}
            </p>
            <p className={cn("text-sm font-medium", STATUS_CLASS[run.status])}>
              {STATUS_LABEL[run.status]}
            </p>
            <p className="text-xs text-muted-foreground">
              {run.config.barneyModel}
              {run.config.count ? ` · ${run.config.count} cases` : " · all cases"} · $
              {run.costUsd.toFixed(4)}
            </p>
          </button>
        </div>
      ))}
    </div>
  );
}
