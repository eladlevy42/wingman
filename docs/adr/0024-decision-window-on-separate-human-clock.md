# Decision window on a separate human clock (DECISION_WINDOW_MINUTES)

## Context

Since ADR-0015, one env var — `MATCH_COOLDOWN_MINUTES` — has driven every timer in the system:
the Match Day sweep cadence, the decision-resolver cadence, the follow-up sweep, candidate-slot
spacing, **and** the decision window itself (`decision.service.ts#isWindowExpired`). At the
1-minute dev default, a user whose match answers Yeah first gets exactly one minute to respond
before silence is treated as Nah (issue #302). Tuning "how fast the machine sweeps" and "how long
a human gets to respond" are different concerns that could not be turned independently.

Three open choices:

1. **Default behavior when unset** — fall back to `MATCH_COOLDOWN_MINUTES`, or ship an opinionated
   default (60 min / 24 h)?
2. **Scope: the choose-times fallback** — after both say Yeah, a silent user gets meeting times
   auto-picked after the same `isWindowExpired` check. Same knob, or the fast clock?
3. **Scope: the follow-up reminder window** — `followup.service.ts#reminderWindowMs` also just
   returned `cooldownMs()`. Include it now or defer?

## Decision

**Two named clocks.** `MATCH_COOLDOWN_MINUTES` is the **system clock**: sweep cadences
(`startOrchestrationLoop`, `startDecisionResolverLoop`, `startFollowUpLoop`) and candidate-slot
spacing (`scheduling.service.ts`). `DECISION_WINDOW_MINUTES` is the **human clock** (glossary:
"Decision Window"): every wait-on-a-human-to-respond timer. Implemented as `decisionWindowMs()`
exported from `orchestration.service.ts` beside `cooldownMs()` — placing it there (rather than in
`decision.service.ts` as the issue sketched) avoids a new import cycle, since decision, follow-up,
and scheduling services all already import from orchestration.

1. **Unset falls back to the system clock.** No opinionated default: behavior is byte-identical to
   before until someone sets the var, and 1-minute local expiry testing keeps working. `.env.example`
   documents a suggested prod value of 60, commented out. Blank values are treated as unset without a
   warning (so `DECISION_WINDOW_MINUTES=` in a copied env file is harmless); otherwise invalid values
   (`abc`, `0`, negative) warn and fall back, mirroring `cooldownMs()`'s guard.
2. **The choose-times fallback rides the human clock.** Both `isWindowExpired` call sites — the
   Yeah/Nah expiry and the auto-schedule fallback — are the same "acting on a human's silence"
   concept, so one knob controls both. A third knob would be over-engineering for a POC.
3. **The follow-up reminder window rides the human clock too**, included now rather than deferred.
   (It is the pre-date `PRE_DATE_REMINDER` window — the `DEBRIEF_NUDGE` fires when the date passes,
   no window involved, and is untouched here.) Consequence accepted deliberately: a long decision
   window widens the reminder window, so the heads-up fires further ahead of the date — at long
   settings it reads as "well before the date" rather than a last-minute ping. One invariant from the
   original `reminderWindowMs` comment survives via `Math.max(decisionWindowMs(), cooldownMs())`: the
   reminder window can never be narrower than the sweep cadence, or a slow sweep could step over it
   entirely (one tick "too early", the next after the date — `PRE_DATE_REMINDER` never fires).

## Consequences

- Deployments get an hour-scale (or day-scale) response window while sweeps stay fast — the original
  #302 complaint — by setting one env var, with zero schema or API changes.
- The window/cadence relationship is now free in both directions. Window ≥ cadence (the intended
  configuration) behaves exactly as before. Window < cadence is safe but coarse for the Yeah/Nah
  expiry — `isWindowExpired` is a one-sided check, so expiry is detected on the next tick rather than
  missed; only the reminder window needed the `Math.max` guard because its check is range-shaped.
- ADR-0015's "both loops read `MATCH_COOLDOWN_MINUTES` … so they tick in lockstep" still holds — this
  ADR changes what the resolver _checks_, never how often anything _runs_.
- `PRODUCT_SPEC.md` §6/§7/§12 and `CONTEXT.md` now name the two clocks; the spec's old "all
  thresholds derive from `MATCH_COOLDOWN_MINUTES`" invariant is replaced by "derive from one of the
  two clocks, never hardcoded".

## Amendment (issue #381)

Point 1's "no opinionated default" choice turned out to be a foot-gun: with `DECISION_WINDOW_MINUTES`
unset, `decisionWindowMs()` fell back to `cooldownMs()`, which itself defaults to 1 minute. Any
deployment that left `MATCH_COOLDOWN_MINUTES` at its dev default auto-Nah'd a real human 60 seconds
after the pitch — the exact coupling this ADR set out to remove, just one level indirect (unset
still inherited the system clock's default, not only an explicit override of it). `decisionWindowMs()`
now falls back to a fixed `DEFAULT_DECISION_WINDOW_MINUTES` (60) on unset, blank, or invalid input,
independent of `MATCH_COOLDOWN_MINUTES` entirely. The rest of this ADR's decisions (the two named
clocks, the choose-times fallback and follow-up reminder window riding the human clock, the
`Math.max` floor in `reminderWindowMs`) are unchanged.
