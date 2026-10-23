import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import AgentCostSummary from "@/components/AgentCostSummary";
import AuditTimeline from "@/components/AuditTimeline";
import { Button } from "@/components/ui/button";
import { useAuditData } from "@/hooks/useAuditData";
import { cn } from "@/lib/utils";

// Dev-only reader for the audit trail (#555, docs/adr/0038). Two views: one
// person's actions with the agent calls each caused, and agent spend by day.
// Mounted only under import.meta.env.DEV, mirroring /dev/match-pipeline.
//
// It displays no message or answer content — not by filtering it out, but
// because neither audit table stores any.

type Tab = "timeline" | "costs";

export default function Audit() {
  const [tab, setTab] = useState<Tab>("timeline");
  const [userId, setUserId] = useState("");
  const {
    timeline,
    timelineLoading,
    timelineError,
    loadTimeline,
    costs,
    costsLoading,
    costsError,
    refreshCosts,
  } = useAuditData();

  return (
    <AppLayout>
      <div className="mx-auto flex w-full max-w-6xl gap-6 px-4 py-8">
        <aside className="w-72 shrink-0 space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Audit</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Events, and the agent calls each one caused. Metadata only — no message content is
              stored.
            </p>
          </div>

          <nav className="space-y-1" aria-label="Audit views">
            {(
              [
                ["timeline", "User timeline"],
                ["costs", "Agent cost"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left text-sm transition-colors",
                  tab === value
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          {tab === "timeline" ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void loadTimeline(userId);
              }}
            >
              <label htmlFor="audit-user-id" className="block text-xs text-muted-foreground">
                User id
              </label>
              <input
                id="audit-user-id"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                placeholder="a UUID"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="submit" size="sm" className="w-full" disabled={timelineLoading}>
                {timelineLoading ? "Loading…" : "Load timeline"}
              </Button>
            </form>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => void refreshCosts()}
              disabled={costsLoading}
            >
              Refresh
            </Button>
          )}
        </aside>

        <main className="flex-1">
          {tab === "timeline" && (
            <>
              {timelineError && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-foreground">
                  {timelineError}
                </div>
              )}
              {!timelineError && !timeline && (
                <p className="text-sm text-muted-foreground">
                  Enter a user id to read their timeline.
                </p>
              )}
              {timeline && <AuditTimeline timeline={timeline} />}
            </>
          )}

          {tab === "costs" && (
            <>
              {costsError && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-foreground">
                  {costsError}
                </div>
              )}
              {costsLoading && !costs && <p className="text-sm text-muted-foreground">Loading…</p>}
              {costs && <AgentCostSummary costs={costs} />}
            </>
          )}
        </main>
      </div>
    </AppLayout>
  );
}
