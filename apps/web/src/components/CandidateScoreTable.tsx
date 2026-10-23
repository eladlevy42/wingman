import type { CandidateScore } from "@wingman/shared";
import { cn } from "@/lib/utils";

function short(id: string): string {
  return id.slice(0, 8);
}

interface CandidateScoreTableProps {
  candidateScores: CandidateScore[];
}

// Deterministic-filter stage of the match pipeline dev view (issue #253).
export default function CandidateScoreTable({ candidateScores }: CandidateScoreTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-3 py-2 font-semibold">Candidate</th>
            <th className="px-3 py-2 font-semibold">Hard criteria</th>
            <th className="px-3 py-2 text-right font-semibold">Overlap</th>
            <th className="px-3 py-2 text-right font-semibold">Shortlist rank</th>
          </tr>
        </thead>
        <tbody>
          {candidateScores.map((c) => (
            <tr
              key={c.candidateId}
              className={cn(
                "border-b border-border/50 last:border-0",
                c.rank !== null && "bg-accent/40"
              )}
              data-testid={c.passedHardCriteria ? "candidate-passed" : "candidate-failed"}
            >
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                {short(c.candidateId)}
              </td>
              <td className="px-3 py-2">
                {c.passedHardCriteria ? (
                  <span className="text-success">passed</span>
                ) : (
                  <span className="text-destructive">failed: {c.failureReason}</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-foreground">
                {c.overlapScore ?? "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-foreground">{c.rank ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
