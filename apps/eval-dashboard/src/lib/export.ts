import type { EvalRunDetail, Track1Result, Track2Result, Track3Result } from "@wingman/shared";

function download(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function runToJson(run: EvalRunDetail): string {
  return JSON.stringify(run, null, 2);
}

export function exportRunAsJson(run: EvalRunDetail): void {
  download(`eval-run-${run.id}.json`, runToJson(run), "application/json");
}

// One flat row per case, track-specific columns — transcripts are omitted
// (too long/newline-heavy for a spreadsheet cell); the JSON export keeps them.
export function rowsForRun(run: EvalRunDetail): Record<string, string | number | boolean>[] {
  if (!run.result) return [];

  if (run.track === 1) {
    return (run.result as Track1Result).perUser.map((r) => ({
      userId: r.userId,
      precision: r.precision,
      expectedCount: r.expected.length,
      actualCount: r.actual.length,
      costUsd: r.costUsd,
      durationMs: r.durationMs,
    }));
  }

  if (run.track === 2) {
    return (run.result as Track2Result).map((r) => ({
      pairId: r.pairId,
      goldenScore: r.goldenScore,
      category: r.category ?? "",
      bandAgreement: r.bandAgreement ?? "",
      scoreA: r.scoreA,
      scoreB: r.scoreB,
      deltaA: r.deltaA,
      deltaB: r.deltaB,
      matched: r.matched,
      judgeScore: r.judgeScore ?? "",
      dealbreakerCapConsistent: r.dealbreakerConsistency
        ? r.dealbreakerConsistency.aConsistent && r.dealbreakerConsistency.bConsistent
        : "",
      totalClaims: r.groundedness?.totalClaims ?? "",
      ungroundedClaims: r.groundedness?.ungroundedCount ?? "",
      costUsd: r.costUsd,
      durationMs: r.durationMs,
    }));
  }

  return (run.result as Track3Result).map((r) => ({
    userId: r.userId,
    transcriptId: r.transcriptId,
    matchCount: r.matchCount,
    fieldCount: r.fieldCount,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
  }));
}

function toCsvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function runToCsv(run: EvalRunDetail): string {
  const rows = rowsForRun(run);
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((col) => toCsvCell(row[col])).join(",")),
  ];
  return lines.join("\n");
}

export function exportRunAsCsv(run: EvalRunDetail): void {
  download(`eval-run-${run.id}.csv`, runToCsv(run), "text/csv");
}
