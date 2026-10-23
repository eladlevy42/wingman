import type { AgentCostResponse, AgentCostRow } from "@wingman/shared";

// The agent-spend half of /dev/audit (#555): what the agents cost, by day,
// model and actor. Production agent spend was unmeasured before #553, so this
// is the first place it can be read at all.

function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function groupByDay(rows: AgentCostRow[]): [string, AgentCostRow[]][] {
  const byDay = new Map<string, AgentCostRow[]>();
  for (const row of rows) {
    const existing = byDay.get(row.day);
    if (existing) existing.push(row);
    else byDay.set(row.day, [row]);
  }
  return Array.from(byDay.entries());
}

export default function AgentCostSummary({ costs }: { costs: AgentCostResponse }) {
  if (costs.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent calls in this range.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in rounded-lg border border-border bg-card p-5 duration-200">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <div>
            <p className="text-xs text-muted-foreground">Total spend</p>
            <p className="font-mono text-lg font-semibold text-foreground" data-testid="total-cost">
              {usd(costs.totalCostUsd)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Calls</p>
            <p className="font-mono text-lg font-semibold text-foreground">{costs.totalCalls}</p>
          </div>
        </div>
        {costs.includesRolledUpDays && (
          // "No calls in March" and "March's raw rows were deleted" are
          // different facts, and a page that showed them identically would be
          // lying by omission (docs/adr/0038, #555).
          <p className="mt-3 text-xs text-muted-foreground">
            Some days in this range are counted from daily rollups — their raw rows have passed the
            retention window and were swept.
          </p>
        )}
      </div>

      {groupByDay(costs.rows).map(([day, rows]) => (
        <section key={day} className="space-y-2">
          <h3 className="font-mono text-sm font-medium text-foreground">{day}</h3>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-4 py-2 text-right font-medium">Calls</th>
                  <th className="px-4 py-2 text-right font-medium">Duration</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.actor}-${row.model}`} className="border-t border-border">
                    <td className="px-4 py-2 text-foreground">{row.actor}</td>
                    <td className="px-4 py-2 font-mono text-muted-foreground">{row.model}</td>
                    <td className="px-4 py-2 text-right font-mono text-foreground">{row.calls}</td>
                    <td className="px-4 py-2 text-right font-mono text-muted-foreground">
                      {row.durationMs}ms
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-foreground">
                      {usd(row.costUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
