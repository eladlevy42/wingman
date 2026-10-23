import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import CandidateScoreTable from "@/components/CandidateScoreTable";
import NegotiationList from "@/components/NegotiationList";
import { useMatchAttemptData } from "@/hooks/useMatchAttemptData";
import { cn } from "@/lib/utils";

// Dev-only audit view of the full deterministic-filter -> negotiation ->
// decision pipeline (issue #253). Distinct from the eval dashboard
// (aggregate accuracy across many runs) — this is a drill-down into
// individual match attempts, live and historical. Mounted only under
// import.meta.env.DEV, mirroring /dev/barney-chat — see App.tsx.

function short(id: string): string {
  return id.slice(0, 8);
}

const STATUS_CLASS: Record<string, string> = {
  RUNNING: "text-secondary",
  MATCHED: "text-success",
  EXHAUSTED: "text-muted-foreground",
  FORCED: "text-foreground",
  FAILED: "text-destructive",
};

export default function MatchPipeline() {
  const { attempts, listLoading, selectedId, detail, error, selectAttempt, refreshList } =
    useMatchAttemptData();

  return (
    <AppLayout>
      <div className="mx-auto flex w-full max-w-6xl gap-6 px-4 py-8">
        <aside className="w-72 shrink-0 space-y-2">
          <div className="mb-2 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-foreground">Match Pipeline</h1>
            <Button size="sm" variant="outline" onClick={refreshList} disabled={listLoading}>
              Refresh
            </Button>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Deterministic scores → negotiation → decision, live and historical.
          </p>
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-foreground">
              {error}
            </div>
          )}
          {listLoading && attempts.length === 0 && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {!listLoading && attempts.length === 0 && (
            <p className="text-sm text-muted-foreground">No match attempts yet.</p>
          )}
          <ul className="space-y-1">
            {attempts.map((attempt) => (
              <li key={attempt.id}>
                <button
                  type="button"
                  onClick={() => selectAttempt(attempt.id)}
                  className={cn(
                    "w-full rounded-lg border border-border p-2 text-left text-xs hover:bg-accent",
                    selectedId === attempt.id && "border-primary bg-accent"
                  )}
                >
                  <p className="font-mono text-muted-foreground">{short(attempt.userId)}</p>
                  <p className={cn("font-medium", STATUS_CLASS[attempt.status])}>
                    {attempt.status}
                  </p>
                  <p className="text-muted-foreground">
                    {attempt.candidateCount} candidates · {attempt.negotiatedCount} negotiated
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="flex-1 space-y-6">
          {!detail && (
            <p className="text-sm text-muted-foreground">Select an attempt to inspect it.</p>
          )}

          {detail && (
            <>
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-foreground">
                    Attempt for user {short(detail.userId)}
                  </p>
                  <span className={cn("text-sm font-medium", STATUS_CLASS[detail.status])}>
                    {detail.status}
                    {detail.status === "RUNNING" && (
                      <span className="ml-2 text-xs text-muted-foreground">polling…</span>
                    )}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Started {new Date(detail.createdAt).toLocaleString()}
                  {detail.completedAt &&
                    ` · completed ${new Date(detail.completedAt).toLocaleString()}`}
                </p>
              </div>

              {detail.failure && (
                <section className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
                  <h2 className="mb-2 text-sm font-semibold text-foreground">
                    {detail.failure.reason === "unexpected_error"
                      ? "Unexpected error"
                      : "Negotiation turn failed"}
                  </h2>
                  <p className="mb-2 text-xs text-destructive">{detail.failure.error}</p>
                  {detail.failure.log.length > 0 ? (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {detail.failure.log.map((message, index) => (
                        <li key={index}>
                          <span className="font-medium text-foreground">{message.speaker}:</span>{" "}
                          {message.content}
                        </li>
                      ))}
                    </ul>
                  ) : detail.failure.reason === "unexpected_error" ? (
                    <p className="text-xs text-muted-foreground">
                      Unexpected error outside a negotiation turn — no failure transcript was
                      captured. Any negotiations completed earlier in this attempt are listed below.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No transcript was produced before the failure.
                    </p>
                  )}
                </section>
              )}

              <section>
                <h2 className="mb-2 text-sm font-semibold text-foreground">
                  Deterministic candidate scores ({detail.candidateScores.length})
                </h2>
                <CandidateScoreTable candidateScores={detail.candidateScores} />
              </section>

              <section>
                <h2 className="mb-2 text-sm font-semibold text-foreground">
                  Negotiations ({detail.negotiations.length})
                </h2>
                <NegotiationList negotiations={detail.negotiations} status={detail.status} />
              </section>
            </>
          )}
        </main>
      </div>
    </AppLayout>
  );
}
