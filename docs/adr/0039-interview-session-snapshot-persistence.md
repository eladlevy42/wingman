# Interview sessions survive an api restart via a persisted engine snapshot

## Context

Issue #545: an in-progress interview (`interview_self` / `interview_wants`) lives only in the api
process's memory — `barney.sessionRegistry`'s `sessions` Map holds the live `InterviewEngine`
instance, keyed by `sessionId`. An api restart (deploy, crash, dev watch reload) silently discarded
every answer given since the interview began: the client's next `/message` call 404s, the client
starts a fresh session, and `InterviewEngine` re-asks every already-answered question (#255) — the
exact failure CONTEXT.md's `Session` glossary entry documented as accepted ("Lost on server
restart"). The user's own words, testing on-device: "i want all the answer to be saved."

Interviews are the product's longest single flow (~20 questions across two phases), so this was the
single most painful failure the app had, and it fired on every production deploy, not just a crash.

Two designs were considered:

1. **Persist every session kind** (pitch/debrief too, via `BarneyAgent`'s conversation history).
   Rejected: pitch/debrief are short, stateless-feeling negotiations with no tree to resume a
   position in — restarting them costs the user a few seconds, not fifteen answers. The
   `BarneyAgent`'s Agent SDK conversation state is also not obviously safe to round-trip through
   JSON. Persisting only where restart cost is actually high keeps the change small, and the
   session registry's existing kind split (`"engine" | "agent"`) is the natural boundary.
2. **Snapshot the engine's own walk state, keyed by `sessionId`**, and rehydrate lazily on a
   registry lookup miss. Chosen — this is what shipped.

## Decision

1. **`InterviewEngine.snapshot()` / `.restore()`** (`interview.engine.ts`) capture and reapply
   exactly the mutable walk state: `language`, `started`, `done`, `currentIndex`, `probesUsed`,
   `history`, `awaitingAddendum`, `wrapupOffered`, `collected`, `transcript`, `factAckIndex`.
   Everything else (tree, copy, schema, persist fn) is deterministic from `mode` via
   `CONFIG_BY_MODE`, so it is never serialized — only re-selected on restore. The live warm
   soft-turn subprocess (#246) is never serialized either; a rehydrated session pays the same
   prewarm cost a brand-new one would.

2. **The snapshot's shape is a Zod schema in `packages/shared`** —
   `EngineSnapshotSchema` and `SnapshotLastTurnSchema` in `schemas/interviewSnapshot.ts`. Only the
   api reads or writes these, so this looks at first like a violation of "schemas live in shared
   because two sides share them". It is there for the stronger reason: **the stored JSON outlives
   the process that wrote it.** A row written by the build being replaced is read by the build
   replacing it — that is the normal case for this feature, not the edge case, because a deploy is
   the most common reason the registry missed. That makes the snapshot a data contract with the
   future, and CLAUDE.md §6's "Zod at the Boundary" applies to storage that crosses a deploy
   exactly as it does to HTTP.

3. **`InterviewSessionSnapshot` Prisma model** stores one row per live engine session: `id`
   (= `sessionId`), `userId`, `mode`, `state` (JSON-encoded `EngineSnapshot`), `lastTurn`
   (JSON-encoded `SnapshotLastTurn`, nullable), `updatedAt`. Deliberately no relation to `User`:
   this is a cache-shaped row keyed by an ephemeral id, and a dangling `userId` only ever means
   "won't rehydrate".

4. **`lastTurn` is part of the snapshot, not an afterthought.** `barney.message.service` dedups a
   retried turn against `session.lastTurn`, which is in-memory. Without persisting it, this feature
   would have _created_ a silent corruption path: the api answers turn `X`, restarts before the
   response lands, the client retries `X`, the rehydrated engine has no memory of it, and `X`'s
   text runs as the answer to the **next** question — recording answer _n_ against question _n+1_.
   Before #545 that was unreachable, because a restart meant "session not found" and the retry
   failed loudly. Persisting `lastTurn` seeds the rebuilt session's dedup so the retry gets the
   cached result instead.

5. **`interviewSnapshot.service.ts`** owns the JSON boundary — `saveInterviewSnapshot`,
   `loadInterviewSnapshot`, `deleteInterviewSnapshot`. The load path refuses a snapshot and deletes
   the row on sight in four cases, deliberately without distinguishing them for the caller: no row;
   idle past `SESSION_TTL_MS` (the durable twin of `sweepExpired` — a restart must not resurrect a
   session that eviction would have killed); a `state` this build cannot parse; and a snapshot whose
   interview already finished. `lastTurn` is parsed leniently by contrast — one unreadable
   `lastTurn` costs the replay dedup for a single retried turn, which is no reason to throw away a
   rehydratable interview. Every write is best-effort and logged: the turn it trails has already
   succeeded, so a snapshot failure must degrade to the pre-#545 behaviour rather than fail the
   user's answer.

6. **`barney.session.service.rehydrateEngineSession`** rebuilds the session, mirroring
   `createSession`'s engine branch (same warm soft-turn, same deps) and then `restore()`ing the
   engine. It re-checks the registry after its `await`, because the stream endpoint and its
   stream-drop fallback (#511) can both miss for the same lost id at once: whoever loads second
   adopts the session the first registered rather than overwriting it. An overwrite would leak the
   first's warm subprocess (`closeWarm` never called) and split the turnId dedup across two engines,
   running the same answer twice.

7. **`barney.message.service`** is the sync point: `sendMessage` falls back to
   `rehydrateEngineSession` on a registry miss before giving up with `SessionNotFoundError`, and
   `runTurn`'s engine branch upserts after every turn that does not complete the interview and
   deletes on the turn that does — the profile is persisted to `Profile`/`WantedProfile` by then,
   so the snapshot's job is over and a stale row must never resurrect a finished interview.

## Consequences

- An engine session now survives not just an api restart but also **TTL eviction**, since both
  converge on the same registry-miss path — but only within `SESSION_TTL_MS` of the last turn,
  because the load path applies the same deadline to the row. The TTL still bounds how long
  progress is recoverable; it no longer decides it by which process happens to be running.
- `CONTEXT.md`'s `Session` glossary entry is now accurate only for `BarneyAgent` (pitch/debrief)
  sessions, and says so explicitly.
- A crash between an engine turn and its snapshot write leaves the row one turn stale, and the user
  re-answers the single in-flight question. Smaller than the multi-turn loss this fixes, and not a
  new failure mode.
- Snapshot rows are never created for pitch/debrief sessions, so restarting those still costs what
  it always did.
- **Not yet instrumented.** CLAUDE.md §6 (added by #552, ADR-0038) requires an `AuditEvent` for
  every state transition. A rehydration is exactly the kind of otherwise-invisible transition the
  audit trail exists for — when an interview behaves oddly after a deploy, "this session was rebuilt
  from a snapshot at turn _n_" is the line you want. #545 shipped before that rule landed; the event
  is owed.
