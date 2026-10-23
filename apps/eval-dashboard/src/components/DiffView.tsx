import type { EvalRunDetail } from "@wingman/shared";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { aggregateScore, caseCount } from "@/lib/aggregate";
import { cn } from "@/lib/utils";

function Delta({
  delta,
  suffix = "",
  decimals = 4,
}: {
  delta: number;
  suffix?: string;
  decimals?: number;
}) {
  const sign = delta > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "ml-2 text-xs",
        delta > 0 ? "text-success" : delta < 0 ? "text-destructive" : "text-muted-foreground"
      )}
    >
      ({sign}
      {delta.toFixed(decimals)}
      {suffix})
    </span>
  );
}

export interface DiffViewProps {
  runA: EvalRunDetail;
  runB: EvalRunDetail;
  onClose: () => void;
}

// Side-by-side comparison of two past runs of the same track — issue #250's
// "diff view" AC, e.g. score/cost deltas after a prompt or model change.
export function DiffView({ runA, runB, onClose }: DiffViewProps) {
  const scoreA = aggregateScore(runA.track, runA.result);
  const scoreB = aggregateScore(runB.track, runB.result);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Comparing two runs</p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close diff
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-x-4 gap-y-3 text-sm">
          <div />
          <div className="font-semibold text-foreground">
            Run A — {new Date(runA.createdAt).toLocaleString()}
          </div>
          <div className="font-semibold text-foreground">
            Run B — {new Date(runB.createdAt).toLocaleString()}
          </div>

          <div className="text-muted-foreground">Aggregate score</div>
          <div className="tabular-nums">{scoreA !== null ? scoreA.toFixed(3) : "—"}</div>
          <div className="tabular-nums">
            {scoreB !== null ? scoreB.toFixed(3) : "—"}
            {scoreA !== null && scoreB !== null && <Delta delta={scoreB - scoreA} decimals={3} />}
          </div>

          <div className="text-muted-foreground">Cost</div>
          <div className="tabular-nums">${runA.costUsd.toFixed(4)}</div>
          <div className="tabular-nums">
            ${runB.costUsd.toFixed(4)}
            <Delta delta={runB.costUsd - runA.costUsd} suffix=" USD" />
          </div>

          <div className="text-muted-foreground">Duration</div>
          <div className="tabular-nums">{(runA.durationMs / 1000).toFixed(1)}s</div>
          <div className="tabular-nums">
            {(runB.durationMs / 1000).toFixed(1)}s
            <Delta delta={(runB.durationMs - runA.durationMs) / 1000} suffix="s" decimals={1} />
          </div>

          <div className="text-muted-foreground">Cases</div>
          <div className="tabular-nums">{caseCount(runA.track, runA.result)}</div>
          <div className="tabular-nums">{caseCount(runB.track, runB.result)}</div>

          <div className="text-muted-foreground">Config</div>
          <div className="font-mono text-xs">{JSON.stringify(runA.config)}</div>
          <div className="font-mono text-xs">{JSON.stringify(runB.config)}</div>
        </div>
      </CardContent>
    </Card>
  );
}
