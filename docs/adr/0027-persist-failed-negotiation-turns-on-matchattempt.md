# A failed negotiation turn persists its partial transcript as a new FAILED MatchAttempt status

## Context

`runNegotiation` built `deliberationLog` incrementally in a `for` loop, but only ever returned it on
full success — if any single turn threw (an Anthropic API error that had already exhausted its own
retries one layer down, in `agentSdkClient.ts`), the exception propagated and the entire transcript,
plus every dollar of real API spend that produced it, was discarded. Nothing recorded that a turn had
even failed, beyond a transient `console.error` in the sweep's per-user catch block
(`orchestration.service.ts`'s `runOrchestrationTick`) — and `matchOneUser`'s `try/finally` still closed
the `MatchAttempt` out as a plain `EXHAUSTED`, indistinguishable from a legitimate "walked the whole
shortlist, nobody matched" outcome. Worse, an uncaught throw skipped past the best-available fallback
entirely (`#chat-flow #8`'s guaranteed-match code sits after the `try/finally`, unreached on rethrow),
so a failed turn didn't just lose the transcript — it denied the user the guaranteed match they'd
otherwise get from a clean `EXHAUSTED`.

`Match.scoreA`/`scoreB` are non-nullable `Int` columns (docs/adr/0010's explicit invariant: "the only
writer today ... always has both scores"), so a scoreless failed negotiation cannot be persisted as a
`Match` row without breaking that invariant. `MatchAttempt`, however, already exists specifically as an
audit record of one user's matching attempt (issue #253) and has direct precedent elsewhere in the
codebase for "this async unit of work may fail, and we still want to record what and why": `EvalRun`
(`packages/database/prisma/schema.prisma`) already carries `status: "failed"` plus a dedicated
`error String?` field for exactly this shape of problem.

## Decision

1. **`runNegotiation` wraps its whole body (negotiation loop, scoring, rationale) in one `try/catch`.**
   On any failure it throws a new `NegotiationTurnFailure` (`negotiation.agent.ts`) carrying whatever
   `deliberationLog`, `costUsd`, and `durationMs` were accrued before the throw, plus the original error
   as `turnError`. This is deliberately broader than just the negotiation-turn loop the issue's
   implementation hints point at: a failure during scoring or rationale generation loses an equally real,
   fully-paid 8-turn transcript, and the identical mechanism (wrap, catch, attach what was built) covers
   both without inventing two different code paths for what is the same underlying problem.
2. **`MatchAttemptStatusSchema` gains `"FAILED"`**, a fourth value alongside `RUNNING`/`MATCHED`/`EXHAUSTED`.
   `MatchAttempt` gains two nullable columns, `failureLog` (JSON-encoded `NegotiationMessage[]`) and
   `failureError` (the thrown message) — populated only for `FAILED`, mirroring `EvalRun`'s
   `error`/`result` pattern rather than reusing or relaxing `Match`'s score invariant.
3. **`matchOneUser` catches `NegotiationTurnFailure` specifically** (not a broad catch-all — any other
   error, e.g. a DB failure or a genuine bug, still propagates unchanged) and completes the attempt
   `FAILED` with the captured log/error, **without rethrowing**. This is the one deliberate behavior
   change beyond "record instead of discard": catching it properly (instead of letting it escape past the
   `try/finally`) means control reaches the best-available fallback exactly the way a clean `EXHAUSTED`
   does — a negotiation turn failure no longer denies the user their guaranteed match. This falls out
   naturally from fixing the persistence gap; it isn't a separately-scoped feature.
4. **No new retry loop.** `agentSdkClient.ts`'s `runAgentQuery` already retries transient errors
   (`rate_limit`/`overloaded`/`server_error`) up to `MAX_ATTEMPTS` (3) with exponential backoff before
   ever rejecting; by the time an exception reaches `runNegotiation`, retries are already exhausted or the
   error is a non-retryable class (auth, truncation). Adding another retry layer around `agent.turn()`
   would duplicate that logic. The issue's "optionally: a single transient turn error is retried" AC is
   satisfied by the existing lower-layer retry, not a new one.
5. **The dev-only Match Pipeline audit page** (`/dev/match-pipeline`, issue #253) gets a `FAILED` entry in
   its `STATUS_CLASS` color map and a new section rendering `detail.failure`'s error message and partial
   transcript when present — the same minimal, convention-following treatment the page's existing
   `RUNNING`/`MATCHED`/`EXHAUSTED` entries already get.

## Consequences

- `completeMatchAttempt`'s signature widens to accept an optional fourth `failure` argument, called only
  from the new `FAILED` path — every existing 3-argument call site (`MATCHED`/`EXHAUSTED`) is unchanged,
  so no other caller needed updating.
- `MatchAttemptDetailSchema` gains a required-but-nullable `failure` field; any other code constructing a
  `MatchAttemptDetail` literal directly (rather than via the schema parse) would need it added — no such
  site exists today outside `matchAttempt.service.ts` and its tests.
- A `FAILED` attempt still shows up as a genuine attempt to a user (its shortlist was walked, at least
  partially) — this is intentionally distinct from `EXHAUSTED` ("everyone was tried and rejected") so the
  audit page and any future analytics can tell "the system decided against everyone" apart from "the
  system never finished deciding."
- `triggerMatchAndGetState` (the dev-only "trigger match now" button, issue #185/#361) no longer 500s on
  a transient mid-negotiation API failure — it now completes normally with a `FAILED` attempt recorded,
  same as any other terminal outcome.
