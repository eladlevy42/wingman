import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalTrack, EvalRunConfig, EvalRunSummary, EvalRunDetail } from "@wingman/shared";
import { TrackSwitcher } from "@/components/TrackSwitcher";
import { RunActionsPanel } from "@/components/RunActionsPanel";
import { HistorySidebar } from "@/components/HistorySidebar";
import { DiffView } from "@/components/DiffView";
import { CaseCard, type CaseData } from "@/components/CaseCard";
import { LiveCaseRow, type LiveCase } from "@/components/LiveCaseRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { startRun, listRuns, getRun, stopRun, subscribeToRun } from "@/lib/api";
import { exportRunAsCsv, exportRunAsJson } from "@/lib/export";
import { bandAgreementRate, inconsistentCount, ungroundedRate } from "@/lib/aggregate";
import { useElapsedTimer } from "@/lib/useElapsedTimer";
import { trackInfo } from "@/lib/tracks";

const DEFAULT_THRESHOLD = 0.7;

function resultRows(run: EvalRunDetail): CaseData[] {
  if (!run.result) return [];
  // Track1Result is a single object ({meanPrecision, perUser}); Track2/3
  // results are arrays — Array.isArray narrows the union where a `track ===
  // 1` check alone would not (the union isn't tagged by `track`).
  return Array.isArray(run.result) ? run.result : run.result.perUser;
}

export default function App() {
  const [track, setTrack] = useState<EvalTrack>(1);
  const [configByTrack, setConfigByTrack] = useState<Record<EvalTrack, Partial<EvalRunConfig>>>({
    1: {},
    2: {},
    3: {},
  });
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);

  const [runs, setRuns] = useState<EvalRunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<EvalRunDetail | null>(null);

  const [activeRun, setActiveRun] = useState<EvalRunSummary | null>(null);
  const [liveCases, setLiveCases] = useState<LiveCase[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [diffPicks, setDiffPicks] = useState<string[]>([]);
  const [diffRuns, setDiffRuns] = useState<[EvalRunDetail, EvalRunDetail] | null>(null);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const isRunning = activeRun !== null;
  const elapsedMs = useElapsedTimer(isRunning);

  const refreshHistory = useCallback(async (forTrack: EvalTrack) => {
    setHistoryLoading(true);
    try {
      const history = await listRuns(forTrack);
      setRuns(history);
      return history;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load run history.");
      return [];
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Track switch loads that track's history — the run-specific state reset
  // (activeRun, liveCases, diff picks, the SSE subscription) happens in
  // handleTrackChange below, an event handler, not here: setState calls at
  // the top of an effect body run synchronously during commit and trigger an
  // extra render, whereas the same calls in an event handler don't.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const history = await refreshHistory(track);
      if (cancelled) return;
      if (history.length > 0) {
        setSelectedRunId(history[0].id);
      } else {
        setSelectedRunId(null);
        setSelectedRun(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [track, refreshHistory]);

  function handleTrackChange(next: EvalTrack) {
    setTrack(next);
    setActiveRun(null);
    setLiveCases([]);
    setDiffPicks([]);
    setDiffRuns(null);
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }

  // Load full detail whenever the selected run changes.
  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    getRun(selectedRunId)
      .then((run) => {
        if (!cancelled) setSelectedRun(run);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load that run.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  // Fetch both picked runs' full detail whenever exactly two are picked.
  // Rendering is gated on `diffPicks.length === 2` (see JSX below), so there
  // is no need to reset diffRuns synchronously here when picks drop below 2.
  useEffect(() => {
    if (diffPicks.length !== 2) return;
    let cancelled = false;
    Promise.all(diffPicks.map((id) => getRun(id)))
      .then(([a, b]) => {
        if (!cancelled) setDiffRuns([a, b]);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Could not load runs to diff.");
      });
    return () => {
      cancelled = true;
    };
  }, [diffPicks]);

  useEffect(() => {
    return () => unsubscribeRef.current?.();
  }, []);

  const handleRun = useCallback(async () => {
    setError(null);
    try {
      const summary = await startRun(track, configByTrack[track]);
      setActiveRun(summary);
      setLiveCases([]);
      setDiffPicks([]);
      setDiffRuns(null);

      unsubscribeRef.current = subscribeToRun(summary.id, (event) => {
        if (event.type === "case") {
          setLiveCases((prev) => [
            ...prev,
            {
              index: event.index,
              total: event.total,
              costUsd: event.caseCostUsd,
              durationMs: event.caseDurationMs,
              score: event.score,
              summary: event.summary,
            },
          ]);
          return;
        }
        // done / stopped / error: the run has reached a terminal state.
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
        setActiveRun(null);
        if (event.type === "error") {
          setError(event.message);
        }
        refreshHistory(track).then((history) => {
          const finishedId = event.type === "error" ? summary.id : event.run.id;
          setSelectedRunId(finishedId);
          if (history.length === 0) setSelectedRunId(finishedId);
        });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the run.");
    }
  }, [track, configByTrack, refreshHistory]);

  const handleStop = useCallback(async () => {
    if (!activeRun) return;
    try {
      await stopRun(activeRun.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop the run.");
    }
  }, [activeRun]);

  function toggleDiffPick(id: string) {
    setDiffPicks((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
  }

  const rows = selectedRun ? resultRows(selectedRun) : [];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-4 py-3">
        <h1 className="text-lg font-semibold text-primary">Wingman Eval Dashboard</h1>
        <p className="text-xs text-muted-foreground">
          Standalone dev tool — not part of the product app. See CLAUDE.md §1 Milestone 4.
        </p>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 p-4 lg:grid-cols-[260px_1fr]">
        <aside className="order-2 lg:order-1">
          <HistorySidebar
            runs={runs}
            loading={historyLoading}
            selectedRunId={selectedRunId}
            diffPicks={diffPicks}
            onSelect={(id) => {
              setDiffPicks([]);
              setSelectedRunId(id);
            }}
            onToggleDiffPick={toggleDiffPick}
          />
        </aside>

        <main className="order-1 flex flex-col gap-6 lg:order-2">
          <TrackSwitcher active={track} onChange={handleTrackChange} />

          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-foreground">
              {error}
            </div>
          )}

          <RunActionsPanel
            track={track}
            config={configByTrack[track]}
            onConfigChange={(config) => setConfigByTrack((prev) => ({ ...prev, [track]: config }))}
            isRunning={isRunning}
            elapsedMs={elapsedMs}
            onRun={handleRun}
            onStop={handleStop}
          />

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Pass/fail threshold
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>
          </div>

          {diffPicks.length === 2 && diffRuns && (
            <DiffView
              runA={diffRuns[0]}
              runB={diffRuns[1]}
              onClose={() => {
                setDiffPicks([]);
                setDiffRuns(null);
              }}
            />
          )}

          {isRunning && (
            <Card>
              <CardHeader>
                <p className="text-sm font-semibold text-foreground">
                  Live — {trackInfo(track).name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {liveCases.length} case{liveCases.length === 1 ? "" : "s"} completed · total cost
                  ${liveCases.reduce((sum, c) => sum + c.costUsd, 0).toFixed(4)}
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {liveCases.length === 0 && (
                  <p className="text-sm text-muted-foreground">Waiting for the first case…</p>
                )}
                {liveCases.map((liveCase) => (
                  <LiveCaseRow key={liveCase.index} liveCase={liveCase} threshold={threshold} />
                ))}
              </CardContent>
            </Card>
          )}

          {!isRunning && diffPicks.length !== 2 && selectedRun && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {trackInfo(selectedRun.track).name} — {selectedRun.status}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(selectedRun.createdAt).toLocaleString()} · $
                    {selectedRun.costUsd.toFixed(4)} · {(selectedRun.durationMs / 1000).toFixed(1)}s
                    {selectedRun.track === 1 &&
                      selectedRun.result &&
                      !Array.isArray(selectedRun.result) && (
                        <> · mean precision {selectedRun.result.meanPrecision.toFixed(3)}</>
                      )}
                    {(() => {
                      const rate = bandAgreementRate(selectedRun.track, selectedRun.result);
                      return rate === null ? null : (
                        <> · band agreement {(rate * 100).toFixed(0)}%</>
                      );
                    })()}
                    {(() => {
                      const inconsistent = inconsistentCount(selectedRun.track, selectedRun.result);
                      return inconsistent !== null ? (
                        <>
                          {" · "}
                          <span className={inconsistent > 0 ? "text-destructive" : undefined}>
                            {inconsistent} dealbreaker cap inconsistenc
                            {inconsistent === 1 ? "y" : "ies"}
                          </span>
                        </>
                      ) : null;
                    })()}
                    {(() => {
                      const rate = ungroundedRate(selectedRun.track, selectedRun.result);
                      return rate === null ? null : (
                        <> · ungrounded claims {(rate * 100).toFixed(1)}%</>
                      );
                    })()}
                  </p>
                  {selectedRun.error && (
                    <p className="mt-1 text-xs text-destructive">{selectedRun.error}</p>
                  )}
                </div>
                {selectedRun.result && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => exportRunAsJson(selectedRun)}
                    >
                      Export JSON
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => exportRunAsCsv(selectedRun)}>
                      Export CSV
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {rows.length === 0 && (
                  <p className="text-sm text-muted-foreground">No cases in this run.</p>
                )}
                {rows.map((row, index) => (
                  <CaseCard
                    key={index}
                    track={selectedRun.track}
                    data={row}
                    threshold={threshold}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </div>
  );
}
