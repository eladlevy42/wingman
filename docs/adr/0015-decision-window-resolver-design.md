# Decision window resolver: separate loop, first-decision anchor, reused MATCH_FOUND

> **Decision 3 superseded by issue #306.** The Blind Date reveal notification now sends its own
> `DATE_ASSIGNED` type instead of reusing `MATCH_FOUND` — the "if a later issue needs to tell the
> two `MATCH_FOUND` sends apart" case in the Consequences section arrived. Decisions 1 and 2
> (separate resolver loop, first-decision window anchor) are unaffected and still stand. The
> historical reasoning below is preserved as-is.

## Context

Issue #57 builds the outcome resolver for the Yeah/Nah decision flow (`docs/PRODUCT_SPEC.md` §6,
`docs/adr/0012-blind-date-replaces-post-match-chat.md`). The issue text left three implementation
choices open that a future reader would otherwise have to reverse-engineer from the diff:

1. Whether the resolver runs as its own `setInterval` or is folded into the existing
   `runOrchestrationTick` sweep (`orchestration.service.ts`) that already runs on the same
   `MATCH_COOLDOWN_MINUTES` cadence.
2. What "the decision window" is anchored to when only one user (or neither) has responded yet —
   neither the Prisma schema nor `docs/PRODUCT_SPEC.md` §6 name an explicit "pitch delivered at"
   timestamp separate from `Match.createdAt`.
3. Whether the Blind Date reveal notification reuses the existing `MATCH_FOUND` notification type
   (already sent once, at negotiation time, by `orchestration.service.ts`'s
   `handleNegotiationOutcome`) or introduces a new type.

## Decision

1. **Separate loop.** `decision.service.ts` owns its own `startDecisionResolverLoop` /
   `stopDecisionResolverLoop`, wired into `apps/api/src/index.ts` alongside
   `startOrchestrationLoop`, rather than adding a second pass inside `runOrchestrationTick`.
   Negotiation (matching `WAITING` users) and decision resolution (resolving `MATCHED` matches
   pending Yeah/Nah) are different sweeps over different rows with different outcomes; keeping them
   as separate functions keeps each one small and independently testable, at the cost of two
   `setInterval` handles instead of one. Both still read the same `MATCH_COOLDOWN_MINUTES` env var
   via the shared `cooldownMs()` helper (now exported from `orchestration.service.ts`), so they tick
   in lockstep.
2. **Window anchored to the first decision, falling back to match creation.** A match with at least
   one non-null `decidedAtA`/`decidedAtB` uses the earlier of the two as the window start — once one
   user responds, the other has exactly one `MATCH_COOLDOWN_MINUTES` window to catch up before
   non-response is treated as Nah. A match where neither has decided yet falls back to
   `Match.createdAt`, so a fully-silent pair still eventually expires instead of staying pending
   forever.
3. **Reuse `MATCH_FOUND`.** The reveal notification sent by `assignBlindDate` reuses the existing
   `NotificationType` value rather than adding e.g. `BLIND_DATE_ASSIGNED`. The issue text names
   `MATCH_FOUND` explicitly ("Send reveal notification (MATCH_FOUND) including the Blind Date
   details"), and the payload (`matchId`, `venue`, `dateTime`) is enough for a client to distinguish
   this richer, second `MATCH_FOUND` from the negotiation-time one if it needs to.

## Consequences

- `decision.service.ts` mirrors `orchestration.service.ts`'s shape (module-level interval handle,
  `isRunning` guard, per-item try/catch in the sweep) — a reader familiar with one recognizes the
  other immediately.
- `Match.venue` doubles as the "not yet resolved" marker for the resolver's query
  (`status: "MATCHED", venue: null`) — no new enum value was added to `Match.status` for a
  "pending decision" state, consistent with how #56 already left `Match.status` untouched when a
  decision is recorded.
- If a later issue needs to tell the two `MATCH_FOUND` sends apart (e.g. different UI copy at
  negotiation time vs. reveal time), it will need to add a new `NotificationType` then — this ADR
  does not preclude that, it just avoids adding one speculatively now.
