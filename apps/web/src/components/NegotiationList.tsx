import { useState } from "react";
import type { MatchAttemptDetail } from "@wingman/shared";
import { cn } from "@/lib/utils";

function short(id: string): string {
  return id.slice(0, 8);
}

interface NegotiationListProps {
  negotiations: MatchAttemptDetail["negotiations"];
  status: MatchAttemptDetail["status"];
}

// Negotiation stage of the match pipeline dev view (issue #253) — an
// accordion of each negotiated candidate's outcome and deliberation log.
export default function NegotiationList({ negotiations, status }: NegotiationListProps) {
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);

  if (negotiations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {status === "RUNNING"
          ? "Waiting for the first negotiation…"
          : "No candidate was negotiated for this attempt."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {negotiations.map((n) => (
        <div key={n.matchId} className="rounded-lg border border-border bg-card">
          <button
            type="button"
            onClick={() =>
              setExpandedMatchId((current) => (current === n.matchId ? null : n.matchId))
            }
            className="flex w-full items-center justify-between p-3 text-left text-sm"
          >
            <span>
              <span className="font-mono text-xs text-muted-foreground">
                {short(n.candidateId)}
              </span>{" "}
              <span
                className={cn(
                  "ml-2 font-medium",
                  n.status === "MATCHED" ? "text-success" : "text-muted-foreground"
                )}
              >
                {n.status}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              A {n.scoreA} · B {n.scoreB}
            </span>
          </button>
          {expandedMatchId === n.matchId && (
            <div className="border-t border-border p-3 text-sm">
              {n.rationale && (
                <p className="mb-2 text-muted-foreground">
                  <span className="font-semibold text-foreground">Rationale:</span> {n.rationale}
                </p>
              )}
              {n.deliberationLog.length === 0 ? (
                <p className="text-xs text-muted-foreground">No transcript recorded.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {n.deliberationLog.map((message, index) => (
                    <li key={index}>
                      <span className="font-semibold text-foreground">{message.speaker}:</span>{" "}
                      <span className="text-muted-foreground">{message.content}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
