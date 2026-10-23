import { useState } from "react";
import type {
  EvalTrack,
  PerUserResult,
  Track2PairResult,
  Track3TranscriptResult,
} from "@wingman/shared";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type CaseData = PerUserResult | Track2PairResult | Track3TranscriptResult;

export function scoreForCase(track: EvalTrack, data: CaseData): number {
  if (track === 1) return (data as PerUserResult).precision;
  if (track === 2) {
    const d = data as Track2PairResult;
    return (d.scoreA + d.scoreB + (d.judgeScore ?? 0)) / 30;
  }
  const d = data as Track3TranscriptResult;
  return d.fieldCount > 0 ? d.matchCount / d.fieldCount : 0;
}

function titleFor(track: EvalTrack, data: CaseData): string {
  if (track === 1) return `User ${(data as PerUserResult).userId.slice(0, 8)}`;
  if (track === 2) return `Pair ${(data as Track2PairResult).pairId.slice(0, 8)}`;
  return `User ${(data as Track3TranscriptResult).userId.slice(0, 8)}`;
}

function summaryFor(track: EvalTrack, data: CaseData): string {
  if (track === 1) {
    const d = data as PerUserResult;
    const hits = d.actual.filter((id) => d.expected.includes(id)).length;
    return `precision ${d.precision.toFixed(2)} (${hits}/${d.expected.length})`;
  }
  if (track === 2) {
    const d = data as Track2PairResult;
    const grounding = d.groundedness
      ? ` · ${d.groundedness.ungroundedCount}/${d.groundedness.totalClaims} ungrounded`
      : "";
    const band =
      d.bandAgreement == null
        ? ""
        : ` · band ${d.bandAgreement ? "✓" : "✗"}${d.category ? ` (${d.category})` : ""}`;
    return `A ${d.scoreA} · B ${d.scoreB} · judge ${d.judgeScore ?? "—"} · golden ${d.goldenScore}${band}${grounding}`;
  }
  const d = data as Track3TranscriptResult;
  return `${d.matchCount}/${d.fieldCount} fields matched`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(formatValue).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface CaseCardProps {
  track: EvalTrack;
  data: CaseData;
  threshold: number;
}

// One expandable accordion card per case — issue #250's "Live results" +
// "History" ACs. Collapsed: score/cost/time + a color-coded pass/fail shade
// against `threshold`. Expanded: full track-specific detail (expected vs.
// actual match ids, negotiation transcript, or field-by-field comparison).
export function CaseCard({ track, data, threshold }: CaseCardProps) {
  const [open, setOpen] = useState(false);
  const score = scoreForCase(track, data);
  const passed = score >= threshold;

  return (
    <Card
      className={cn("overflow-hidden", passed ? "border-success/40" : "border-destructive/40")}
      data-testid={passed ? "case-pass" : "case-fail"}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-4 p-4 text-left",
          passed ? "bg-success/10" : "bg-destructive/10"
        )}
      >
        <div>
          <p className="text-sm font-medium text-foreground">{titleFor(track, data)}</p>
          <p className="text-xs text-muted-foreground">{summaryFor(track, data)}</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-xs text-muted-foreground">cost</p>
            <p className="text-sm tabular-nums text-foreground">${data.costUsd.toFixed(4)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">time</p>
            <p className="text-sm tabular-nums text-foreground">
              {(data.durationMs / 1000).toFixed(1)}s
            </p>
          </div>
          <span aria-hidden className="text-muted-foreground">
            {open ? "▲" : "▼"}
          </span>
        </div>
      </button>
      {open && (
        <div className="border-t border-border p-4 text-sm">
          {track === 1 && <Track1Detail data={data as PerUserResult} />}
          {track === 2 && <Track2Detail data={data as Track2PairResult} />}
          {track === 3 && <Track3Detail data={data as Track3TranscriptResult} />}
        </div>
      )}
    </Card>
  );
}

function Track1Detail({ data }: { data: PerUserResult }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <p className="text-xs font-semibold text-muted-foreground">Expected</p>
        <ul className="mt-1 space-y-0.5 font-mono text-xs">
          {data.expected.map((id) => (
            <li
              key={id}
              className={data.actual.includes(id) ? "text-success" : "text-muted-foreground"}
            >
              {id}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-xs font-semibold text-muted-foreground">Actual</p>
        <ul className="mt-1 space-y-0.5 font-mono text-xs">
          {data.actual.map((id) => (
            <li
              key={id}
              className={data.expected.includes(id) ? "text-success" : "text-destructive"}
            >
              {id}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Track2Detail({ data }: { data: Track2PairResult }) {
  const consistency = data.dealbreakerConsistency;
  const inconsistent =
    consistency !== null && (!consistency.aConsistent || !consistency.bConsistent);
  const g = data.groundedness;
  return (
    <div className="space-y-3">
      {data.bandAgreement != null && (
        <p className={data.bandAgreement ? "text-muted-foreground" : "text-destructive"}>
          <span className="font-semibold text-foreground">Band agreement:</span>{" "}
          {data.bandAgreement ? "in band" : "out of band"}
          {data.category ? ` — golden ${data.category}` : ""}
        </p>
      )}
      {data.judgeRationale && (
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">Judge:</span> {data.judgeRationale}
        </p>
      )}
      {consistency && (
        <p className={inconsistent ? "text-destructive" : "text-muted-foreground"}>
          <span className="font-semibold text-foreground">Dealbreaker cap adherence:</span>{" "}
          {inconsistent ? "inconsistent" : "consistent"} — {consistency.explanation}
        </p>
      )}
      {g && (
        <div className="rounded-md border border-border p-3">
          <p className="text-xs font-semibold text-foreground">
            Groundedness: {g.ungroundedCount}/{g.totalClaims} claims ungrounded (
            {(g.ungroundedRate * 100).toFixed(0)}%)
          </p>
          {g.flags.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {g.flags.map((flag, i) => (
                <li key={i} className="text-xs text-destructive">
                  <span className="font-medium">{flag.speaker}:</span> “{flag.claim}” —{" "}
                  <span className="text-muted-foreground">{flag.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs text-foreground">
        {data.transcript}
      </pre>
    </div>
  );
}

function Track3Detail({ data }: { data: Track3TranscriptResult }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1 pr-4">Field</th>
            <th className="py-1 pr-4">Expected</th>
            <th className="py-1">Actual</th>
          </tr>
        </thead>
        <tbody>
          {data.fields.map((field) => (
            <tr key={field.field} className="border-b border-border/50 last:border-0">
              <td className="py-1 pr-4 font-medium text-foreground">{field.field}</td>
              <td className="py-1 pr-4 font-mono">{formatValue(field.expected)}</td>
              <td
                className={cn("py-1 font-mono", field.match ? "text-success" : "text-destructive")}
              >
                {formatValue(field.actual)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
