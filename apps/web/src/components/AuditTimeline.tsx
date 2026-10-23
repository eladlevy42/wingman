import type { AgentCallView, AuditTimelineResponse } from "@wingman/shared";
import { cn } from "@/lib/utils";

// The per-user timeline half of /dev/audit (#555): what someone did, and the
// agent calls each action caused, joined by correlationId.
//
// Everything rendered here is metadata — ids, timings, enum members, counts.
// There is no message or answer text to show because neither audit table
// stores any (docs/adr/0038), and this component could not display it if asked.

const OUTCOME_CLASS: Record<string, string> = {
  ok: "text-success",
  failed: "text-destructive",
  auth_error: "text-destructive",
  sdk_unavailable: "text-destructive",
};

function short(id: string): string {
  return id.slice(0, 8);
}

function time(iso: string): string {
  return new Date(iso).toLocaleString();
}

function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function AgentCallRow({ call }: { call: AgentCallView }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="font-medium text-foreground">
        {call.actor}
        <span className="text-muted-foreground"> · {call.purpose}</span>
      </span>
      <span className="font-mono text-muted-foreground">{call.model}</span>
      <span className="font-mono text-muted-foreground">{usd(call.costUsd)}</span>
      <span className="font-mono text-muted-foreground">{call.durationMs}ms</span>
      {call.retryCount > 0 && (
        <span className="text-muted-foreground">
          {call.retryCount} {call.retryCount === 1 ? "retry" : "retries"}
        </span>
      )}
      {call.toolNames.length > 0 && (
        <span className="font-mono text-muted-foreground">{call.toolNames.join(", ")}</span>
      )}
      <span className={cn("font-medium", OUTCOME_CLASS[call.outcome] ?? "text-muted-foreground")}>
        {call.outcome}
      </span>
      {call.errorMessage && (
        <span className="font-mono text-muted-foreground">{call.errorMessage}</span>
      )}
    </li>
  );
}

export default function AuditTimeline({ timeline }: { timeline: AuditTimelineResponse }) {
  if (timeline.entries.length === 0 && timeline.unattributedCalls.length === 0) {
    return <p className="text-sm text-muted-foreground">No audit events for that user.</p>;
  }

  return (
    <div className="space-y-6">
      {timeline.entries.map((entry) => (
        <article
          key={entry.id}
          className="animate-in fade-in space-y-3 rounded-lg border border-border bg-card p-5 duration-200"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">{entry.type}</h3>
            <span className="font-mono text-xs text-muted-foreground">{time(entry.createdAt)}</span>
          </header>

          {Object.keys(entry.payload).length > 0 && (
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              {Object.entries(entry.payload).map(([key, value]) => (
                <div key={key} className="flex gap-1.5">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="font-mono text-foreground">{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}

          <p className="font-mono text-xs text-muted-foreground">
            correlation {short(entry.correlationId)}
          </p>

          {entry.agentCalls.length > 0 && (
            <ul className="space-y-1.5 border-t border-border pt-3">
              {entry.agentCalls.map((call) => (
                <AgentCallRow key={call.id} call={call} />
              ))}
            </ul>
          )}
        </article>
      ))}

      {timeline.unattributedCalls.length > 0 && (
        <article className="space-y-3 rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-medium text-foreground">Agent calls with no user action</h3>
          {/* Caused by the clock rather than by anything this person did — a
              sweep's negotiation turns. Shown rather than dropped, so the
              spend on this page still adds up to what the table holds. */}
          <p className="text-xs text-muted-foreground">
            Caused by a background sweep rather than by something this person did.
          </p>
          <ul className="space-y-1.5 border-t border-border pt-3">
            {timeline.unattributedCalls.map((call) => (
              <AgentCallRow key={call.id} call={call} />
            ))}
          </ul>
        </article>
      )}
    </div>
  );
}
