# A negotiation timeout and a sweep-wide spend budget bound the matching engine's worst case

## Context

One negotiation is up to 8 agent turns plus 2 scoring calls and a rationale — up to 11 Agent SDK
calls — and `matchOneUser` walks up to 5 shortlisted candidates serially per user, so a single
user's cycle could already run ~50 model calls with no upper bound on wall-clock or spend before
this issue. Two specific failure modes had no guardrail:

1. **A hung call stalls the whole sweep.** `runAgentQuery` retries transient errors but has no
   timeout of its own — a genuinely stuck Agent SDK subprocess (issue #410's class of failure) would
   never resolve or reject, so `matchOneUser`'s `await negotiateAndPersist(...)` would simply never
   return. Because `runOrchestrationTick` and the manual/first-cycle triggers share the module-level
   `isRunning` lock (docs/adr/0011 §"SINGLE-PROCESS ASSUMPTION"), one stuck call doesn't just delay
   one user — it wedges every subsequent tick behind the held lock indefinitely.
2. **No spend ceiling.** A sweep over many `WAITING` users multiplies the per-user worst case with
   nothing to stop it — `NegotiationAgent.getUsage()` already tracks real cost/duration per instance
   (added for the eval dashboard, #250) but nothing outside eval consulted it.

## Decision

1. **`apps/api/src/lib/withTimeout.ts`** is a generic race-against-a-timer helper. It does not cancel
   the underlying promise — there is no way to abort an in-flight Agent SDK call — it only stops the
   caller from waiting past the deadline; the original call keeps running in the background and its
   eventual settlement is discarded (a `.catch` no-op prevents an unhandled-rejection warning).
2. **`negotiationTimeoutMs()`** (env `NEGOTIATION_TIMEOUT_MS`, default 5 minutes) wraps each
   `negotiateAndPersist` call inside `matchOneUser`'s shortlist loop. A timeout is caught and treated
   as **REJECTED-equivalent**: both users simply stay `WAITING`, the candidate is marked processed
   (consistent with a clean rejection), and the loop continues to the next candidate — deliberately
   distinct from a `NegotiationTurnFailure` (#339) or an unexpected error, neither of which fit "the
   call never came back." Logged loudly via `console.error` so a real hang is visible operationally.
3. **`sweepBudgetUsd()`** (env `SWEEP_BUDGET_USD`, default `null` = uncapped) and a plain
   `{ spentUsd: number }` tracker (`SweepBudget`) accumulate real spend across every user
   `matchOneUser` processes within one sweep/cycle. Each top-level entry point
   (`runOrchestrationTick`, `triggerFirstMatchCycle`, `startMatchCycle`) creates its own fresh
   tracker, so `runOrchestrationTick`'s cap spans the whole tick's many users, while a single
   guaranteed cycle gets its own budget scoped to just that user's shortlist walk.
4. **`negotiateAndPersist` gains an optional 4th `onUsage` parameter** (not a return-shape change) so
   the sweep can observe each negotiation's real cost without widening the function's contract for
   its other caller (the manual `/api/match/negotiate` route) or requiring every existing test/call
   site to handle a new shape.
5. **The budget check runs before each candidate**, not just once at the top: once `spentUsd` meets
   the cap, the shortlist walk stops (`stoppedReason: "sweep_budget"` recorded on the `MatchAttempt`,
   `packages/shared`'s new `StoppedReasonSchema`/`stoppedReason` column) and the user stays `WAITING`
   for the next tick — the remaining candidates are never tried. The same exhausted-budget check also
   suppresses the guarantee/failure fallback (`forceBestAvailable`) for this cycle: once the circuit
   breaker trips, no further Anthropic spend happens this tick, including the fallback's own
   (cheap, but non-zero) rationale call. Note that suppressing that call is the _only_ lever the
   budget has over it: `forceMatchAndPersist` hardcodes `costUsd: 0` on its synthesized
   `NegotiationResult` even though `writeFallbackRationale` is a real Agent SDK call, so the
   fallback's actual spend has never been visible to `spentUsd` — before or after this change. The
   budget therefore bounds negotiation spend accurately and fallback spend only by preventing it,
   never by counting it.
6. **Defaults preserve today's behavior until an operator opts in**: `NEGOTIATION_TIMEOUT_MS` unset
   falls back to a generous 5 minutes (a legitimate negotiation, in the worst case of every call
   needing its full retry backoff, could occupy several minutes — this only needs to catch a call
   that never returns at all); `SWEEP_BUDGET_USD` unset means no cap at all, mirroring the eval
   dashboard's `budgetCapUsd` semantics (#250) where an explicit opt-in is required.

## Consequences

- A stuck Agent SDK subprocess mid-negotiation no longer wedges the orchestration lock forever — it
  costs at most `NEGOTIATION_TIMEOUT_MS` before the sweep moves on.
- An abandoned (timed-out) negotiation may still complete in the background and persist a `Match` row
  after the caller has moved on — an inherent limitation of "there is no way to cancel an in-flight
  Agent SDK call," not something this change attempts to solve. In practice this only matters for a
  call that eventually _does_ return after genuinely hanging past the timeout, which the timeout's
  existence implies is already an abnormal case.
- Operators can bound total negotiation spend per sweep/cycle by setting `SWEEP_BUDGET_USD`; the POC's
  demo/dev defaults are unaffected until they do.
- `MatchAttemptDetail` gains a `stoppedReason` field (nullable) alongside the existing `failure`
  field — distinct concepts: `failure` is something that broke; `stoppedReason` is a deliberate early
  exit that still completes the attempt normally (`EXHAUSTED`/`FORCED`), just without trying every
  shortlisted candidate.
