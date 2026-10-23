# The audit trail records events, not content, and the event vocabulary is the privacy gate

## Context

Wingman has five audit surfaces already, each built for one domain and justified by
its own ADR:

- **Interview transcript** — `Profile.rawTranscript` / `WantedProfile.rawTranscript`,
  every turn including probes, re-asks and back-navigation (docs/adr/0036).
- **Match Attempt** — `MatchAttempt`, the full scored candidate pool, hard-criteria
  pass/fail, negotiation order, failure log and stop reason, read by `/dev/match-pipeline`.
- **Negotiation record** — `Match.deliberationLog`, `rationale`, `scoreA`/`scoreB` (docs/adr/0007, 0010).
- **Debrief record** — `FeedbackRound.rawTranscript` plus the extracted `FeedbackDelta`.
- **Eval runs** — `EvalRun`, per-run cost, duration, config and per-case results.

What does not exist is anything cross-cutting. There is no structured logger at all
(31 scattered `console.*` calls across 11 files). `runAgentQuery` — the single
stateless chokepoint every agent in the app goes through (docs/adr/0011) — already
computes `costUsd`, `durationMs` and `toolUses` on every call and **discards them
outside the eval path**, so production agent spend is unmeasured. Nothing links a
user action to the agent calls it caused. And `User.matchingState` records where a
user is with no record of how or when they got there, so a user sitting in
`REJECTED` is unexplainable after the fact.

"Track everything" is three problems in one coat, and they pull in different
directions:

1. **Bug traceability** — replay one user's session. High granularity, short
   retention, per-user query.
2. **Product statistics** — funnel and drop-off. Aggregates, long retention, no
   per-user identity needed at all.
3. **Agent accountability and cost** — what every agent did, what it cost, joined to
   the business outcome it produced.

The data this app holds makes the privacy question load-bearing rather than
ceremonial: `WantedProfile.genderPreference`, faith and kids stances carried in the
Negotiation Fields, `universityEmail`, `studentId`, `phone`, and `photoUrl`. A second
store that duplicates any of that doubles the exposure and buys nothing the domain
tables do not already provide.

One existing hole shapes the design: **there is no user-deletion endpoint**, and
`Match.userAId`/`userBId` carry no `onDelete` behaviour, so deleting a user fails on
a foreign key today. An audit log that is hard to erase would deepen a hole that is
already open.

## Decision

**Two narrow append-only tables, a closed event vocabulary that acts as the privacy
gate, and metadata only — never content.**

### `AuditEvent` and `AgentCall`, not one table

`AuditEvent` records one row per meaningful user action or state transition.
`AgentCall` records one row per `runAgentQuery` — actor, purpose, model, `costUsd`,
`durationMs`, tool names, retry count, outcome. They are split because their write
rates differ by an order of magnitude (one Match Day sweep is 500 users × 5
candidates × 4 turns of agent calls against a handful of user actions) and because
`AgentCall` has a fixed column shape while `AuditEvent` is polymorphic. A single
table would force the agent columns to be nullable on every user-action row and turn
the whole thing into a `payload` blob that nothing can query in six weeks.

### The event-type enum is the PII gate

`AuditEventType` is a closed union in `packages/shared`, and each member has its own
Zod payload schema. The write path parses the payload against the schema for its
type; anything that does not parse is dropped and logged, never written raw. "We
promise not to log PII" is unenforceable; a Zod parse at the write boundary is
enforceable, and testable in Vitest.

### Metadata only

An audit row records _that_ a Phase 1 turn happened — node index, latency, answer
length, interview language — never the answer text. Content stays in the domain
tables that already have ADRs justifying it. This is what makes the audit tables
safe to query freely for statistics: they carry `userId` (already a UUID) and nothing
else identifying — no email, phone, name, `studentId` or `photoUrl`.

### Write-only, and purpose-limited

Nothing ever replays an audit row to a model, shows one to another user, or feeds one
back into matching. This inherits the doctrine docs/adr/0036 set for the interview
transcript and keeps docs/adr/0004's code-owned flow intact. The last clause is the
one with teeth: the moment audit data influences who gets matched with whom, the
system is doing automated profiling on intimate data, which is a categorically
different thing from debugging.

### `correlationId` threads a user action to its agent calls

Generated at the API boundary, one per request, carried on both tables. This requires
a new audit-context parameter on `AgentQueryParams` threaded through every agent call
site — the widest part of the diff, and the deliberate cost of instrumenting the one
chokepoint that covers **every agent in the app**: all four `BarneyMode` sessions,
`negotiation.agent`, `evalJudge`, `consistencyJudge` and `groundednessJudge`.

### Pre-auth client events use an anonymous session id that is never linked

Client telemetry fires on Landing, Register and Login, before any `userId` exists. It
carries a random id generated per app launch, held in memory and never persisted to
the device or stitched to a `userId` on registration. Register-funnel drop-off is
therefore answerable in aggregate, while the retroactive "replay this identified
person's journey from first open" capability is one the system simply does not have.

### 90-day TTL with permanent aggregates

A sweep deletes `AuditEvent` and `AgentCall` rows older than 90 days; rolled-up daily
counters survive indefinitely. Month-over-month statistics survive the deletion
because the rollup, not the raw row, is the long-lived artefact. Erasure for one
person is a delete by `userId` on two tables.

### Writes are fire-and-forget

CLAUDE.md §9 rules out Redis or a queue, so these are direct SQLite writes. Every
write is fire-and-forget with its error caught and logged: an audit failure must
never break the user request that produced it, and SQLite's single writer is shared
with the matching sweep doing the actual work.

### Client telemetry is untrusted input

`POST /api/telemetry` accepts a batched array, validated against the same closed enum
and Zod schemas, with a capped batch size and a rate limit. Anything a client can
POST, an attacker can POST — on a single-writer SQLite file, an unbounded telemetry
endpoint is a denial-of-service surface, not just a data-quality one.

Alternatives considered and rejected:

- **One fat `AuditEvent` table for everything.** Fewer tables, one writer, one query
  surface. Rejected on volume and shape: the sweep's agent-call rows would swamp the
  user-action rows they are meant to sit beside, and a schema wide enough for both is
  a schema specific to neither.
- **Structured logs to stdout (pino), no database.** Cheap, and genuinely better for
  live debugging. Rejected because it answers none of the statistics half, is lost on
  restart, and no `/dev` page can read it. Worth adding later _alongside_ this, not
  instead of it.
- **Extend the existing domain tables only.** Cheapest, and consistent with how every
  audit surface in the repo was built so far. Rejected because it never answers "what
  did this user do at 14:03", and because every future feature would need its own
  bespoke audit table — which is how five disconnected surfaces happened in the first
  place.
- **Store full prompt and response text on every agent call.** The best possible bug
  replay, and the reason `MatchAttempt.failureLog` exists. Rejected as a default: it
  duplicates intimate content into a second store with a different retention and a
  different reader. `MatchAttempt.failureLog` stays as-is — it is scoped to a failure
  that already lost paid API spend, which is a narrower bargain than logging every
  call.
- **A persisted device id stitched to `userId` at registration.** Gives a complete
  per-person journey from first app open. Rejected: it is precisely the retroactive
  identification pattern that turns aggregate funnel measurement into profiling, and
  the drop-off number that motivated client telemetry is available without it.

## Consequences

- `runAgentQuery`'s signature gains an audit-context parameter, so every file in
  `apps/api/src/agents/` changes. This is a mechanical but wide diff, and it is the
  price of the guarantee that no agent can run unrecorded — including agents added
  after this ADR, which cannot reach the API any other way.
- **`apps/web` has 37 direct `fetch(` calls and no central API client**, unlike
  `apps/mobile`, whose `lib/api.ts` is a genuine chokepoint. Web emission is therefore
  a router-level route-change listener plus explicit `track()` calls at key actions —
  not an API-client wrapper. The two clients emit the same events by different
  mechanics, and the mobile side is the cheaper of the two to instrument.
- Production agent cost becomes measurable for the first time. `SWEEP_BUDGET_USD`
  currently caps a sweep from in-memory accounting that is discarded when the sweep
  ends; `AgentCall` makes the same spend queryable afterwards, across sweeps.
- Statistics are queries over two tables, not a service. No aggregation layer is built
  until a real question needs one — the rollup table is the only pre-computed thing.
- Deleting a user **still** fails on the `Match` foreign key. This ADR does not fix
  that, and deliberately does not make it worse: both audit tables are erasable by
  `userId` in one statement each. The missing deletion endpoint is its own issue.
- `AuditEvent` rows exist for users who never complete onboarding, which no domain
  table records today. That is the point — the drop-off between Register and Phase 1
  is currently invisible.
- The 90-day sweep is a fourth recurring timer in a process that already runs the
  Match Day sweep, the follow-up sweep and the decision-window resolver. It runs far
  less often than any of them, but it is one more thing that must not overlap a
  matching sweep's write.

## Update (issue #553) — `runAgentQuery` is not the only route to the API, so the warm session writes rows too

**Problem:** the decision above says `AgentCall` records "one row per `runAgentQuery`", and
its consequences call that function "the one chokepoint that covers **every agent in the
app**". Implementing the instrumentation showed that premise to be out of date.
`agentSdkSession` (the warm interview session, issues #246 and #249) calls the SDK's `query`
directly rather than going through `runAgentQuery` — it exists precisely to avoid the fresh
subprocess spawn that `runAgentQuery` pays on every call. It is also the highest-volume agent
spend in production: every soft turn of every interview runs through it, and the stateless
path serves only the fallback when a warm session dies.

Recording only `runAgentQuery` would therefore have produced a table whose totals were
**wrong** rather than partial — near-zero interview spend, with the cost of the most-used
agent in the product invisible — which defeats the "production agent cost becomes measurable"
consequence this ADR claims.

**Decision, unchanged in substance:** every route to the Anthropic API writes an `AgentCall`
row. There are two, and `AgentSessionConfig` takes the same required audit context as
`AgentQueryParams`, for the same reason: a required parameter is what makes "no agent can run
unrecorded" true by construction rather than by discipline. `prewarm()`'s throwaway turn is
real spend, so it is recorded under its own `session_prewarm` purpose rather than counted as a
soft turn.

**One narrowing:** a failed call records a content-free code — the error's class name plus the
SDK's own error code or result subtype — never the error's message. An error message is free
text, and free text this close to a model is a content leak waiting to happen; the metadata-only
rule above has no exception for the error column. The full message still goes to the console,
where it is a debugging aid rather than a row in a queryable table with a 90-day life. The cost
is that a subprocess failure's "executable not found at ..." detail is console-only.
