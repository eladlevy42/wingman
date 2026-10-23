# The composer stays locked for a whole turn, reveal included

## Context

Barney's streaming replies are painted by a typewriter "smooth reveal" (see
`packages/shared/src/smoothReveal.ts`) rather than dumped in as network deltas land. Two pieces of
state used to be one flag: `loading` drove both the typing indicator and the composer's disabled
state, and it was set false on the reveal's **first revealed character** so the indicator could hand
over to the bubble Barney is typing into.

That left a window of a second or more in which the composer was live while a turn was still
running. Sending into that window (#491) started a second `streamingTurn` on top of the first. Both
turns' reveal loops then wrote to `prev[prev.length - 1]` — "whatever bubble is last" — and their
18 ms ticks wove the two replies together character by character inside one bubble:

```
"— GoI't m itBa. rnSoey w. haHot w acoltud alarlye  pyoulu?ls you towards..."
```

The issue proposed three fixes and asked for "some combination". Two were unambiguous and both
landed: give the reveal ownership of the bubble it opened (`createTurnBubbles`), and give a turn a
way to stop a previous reveal. The third — what the composer should do while a reveal is still
running — was a genuine product choice with no obviously right answer.

## Decision

**A turn is not over until its reveal has drained, and the composer is locked for all of it.**

1. `loading` now means only "show the typing indicator". Its lifecycle is unchanged: on at turn
   start, off at the first revealed character.
2. A new `busy` flag means "a turn is in flight, reveal included". It is set alongside `loading` and
   cleared in the same `finally` that ends the turn — i.e. after `await reveal.drained`.
3. `BarneyChat` (both clients) gates every control on `loading || busy || disabled`. `busy` is an
   optional prop, so the surfaces that do not stream (Phase 2, pitch, debrief) are unaffected.
4. A `turnActiveRef` flips synchronously at the top of each handler, because two taps landing in the
   same React batch both read the pre-update `busy`.

The rejected alternative was **accept the send and flush the previous reveal** — paint the rest of
the previous reply instantly, then start the new turn. It preserves the "you can start typing early"
feel, and with bubble ownership in place the transcript would still be correct. It was rejected
because it makes two `streamingTurn` calls genuinely overlap, and the older turn's `done` event
carries `section` / `progress` / `input`. That metadata is applied after `reveal.drained` resolves,
so a flushed turn would apply its input descriptor _after_ the newer turn had already started —
rendering the age picker or choice chips against the wrong question. Trading a visible correctness
bug for a nicety is a bad deal, and the nicety is small: replies reveal at ~110 chars/sec with
catch-up above a 140-char backlog, so the lock is typically well under a second.

## Consequences

- The user cannot answer until Barney has finished typing. This is the deliberate cost. If it reads
  as sluggish in practice, the fix is not to unlock `busy` — it is to build real turn serialization
  (queue the send, drain the previous turn including its metadata, then start the next one), at
  which point this ADR should be revisited rather than worked around.
- `loading` and `busy` must not be re-merged. The pair is the whole point: one is a visual state,
  the other is a lifecycle state, and they legitimately differ for most of a turn's duration.
- The scheduler moved from `apps/web/src/lib/smoothReveal.ts` to `packages/shared`, and
  `apps/mobile/hooks/useBarneyChat.ts` lost its inline copy of it. `packages/shared` is described in
  ADR-0032 as the shared-by-import boundary between the clients; it is mostly Zod schemas but
  already carries non-schema logic (`geo.ts`), and a scheduler both clients run is exactly what that
  boundary is for. The drift between the two copies is what let #487 sit unfixed on web after mobile
  was fixed — one implementation, one set of tests, is the point.
- Bubble ownership makes #487 unreachable by construction rather than only by the caller remembering
  to call `reveal.stop()`. `stop()` is kept: it still discards text that should never be shown, and
  ownership alone would leave the rest of a failed reply typing itself out above the error bubble.
