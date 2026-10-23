import type { ReactNode } from "react";
import { EVAL_MODELS } from "@wingman/shared";
import type { EvalTrack, EvalRunConfig, EvalModel } from "@wingman/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatElapsed } from "@/lib/useElapsedTimer";

const inputClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export interface RunActionsPanelProps {
  track: EvalTrack;
  config: Partial<EvalRunConfig>;
  onConfigChange: (config: Partial<EvalRunConfig>) => void;
  isRunning: boolean;
  elapsedMs: number;
  onRun: () => void;
  onStop: () => void;
  disabled?: boolean;
}

// Storybook-style "actions" panel (issue #250): configures the next run
// (subset size, model tiers, seed, budget cap) and hosts the Run/Stop button
// + elapsed timer. Field visibility adapts per track — Track 1 has no
// LLM-backed steps, so model/turn fields only show for Track 2/3.
export function RunActionsPanel({
  track,
  config,
  onConfigChange,
  isRunning,
  elapsedMs,
  onRun,
  onStop,
  disabled,
}: RunActionsPanelProps) {
  function set<K extends keyof EvalRunConfig>(key: K, value: EvalRunConfig[K] | undefined) {
    onConfigChange({ ...config, [key]: value });
  }

  function numberField(value: number | undefined) {
    return value === undefined ? "" : String(value);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Run configuration</p>
          <p className="text-xs text-muted-foreground">Configure this run, then hit Run.</p>
        </div>
        <div className="flex items-center gap-3">
          {isRunning && (
            <span className="font-mono text-sm text-muted-foreground" data-testid="run-timer">
              {formatElapsed(elapsedMs)}
            </span>
          )}
          {isRunning ? (
            <Button variant="destructive" onClick={onStop} data-testid="stop-run">
              Stop
            </Button>
          ) : (
            <Button onClick={onRun} disabled={disabled} data-testid="run-eval">
              Run
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Field label="Case count (blank = all)">
          <input
            type="number"
            min={1}
            className={inputClass}
            value={numberField(config.count)}
            disabled={isRunning}
            onChange={(e) => set("count", e.target.value ? Number(e.target.value) : undefined)}
          />
        </Field>
        <Field label="Seed">
          <input
            type="number"
            className={inputClass}
            value={numberField(config.seed)}
            disabled={isRunning}
            onChange={(e) => set("seed", e.target.value ? Number(e.target.value) : undefined)}
          />
        </Field>
        {track === 2 && (
          <Field label="Negotiation turns (must be even)">
            <input
              type="number"
              min={2}
              max={8}
              step={2}
              className={inputClass}
              value={numberField(config.turns)}
              disabled={isRunning}
              onChange={(e) => set("turns", e.target.value ? Number(e.target.value) : undefined)}
            />
          </Field>
        )}
        {(track === 2 || track === 3) && (
          <Field label="Barney model">
            <select
              className={inputClass}
              value={config.barneyModel ?? "sonnet"}
              disabled={isRunning}
              onChange={(e) => set("barneyModel", e.target.value as EvalModel)}
            >
              {EVAL_MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </Field>
        )}
        {track === 2 && (
          <Field label="Judge model">
            <select
              className={inputClass}
              value={config.judgeModel ?? "sonnet"}
              disabled={isRunning}
              onChange={(e) => set("judgeModel", e.target.value as EvalModel)}
            >
              {EVAL_MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Budget cap, USD (blank = none)">
          <input
            type="number"
            min={0}
            step="0.01"
            className={inputClass}
            value={numberField(config.budgetCapUsd)}
            disabled={isRunning}
            onChange={(e) =>
              set("budgetCapUsd", e.target.value ? Number(e.target.value) : undefined)
            }
          />
        </Field>
      </CardContent>
    </Card>
  );
}
