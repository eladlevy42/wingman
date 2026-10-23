# User deletion anonymises the departing side of a shared record rather than erasing it

## Context

Issue #561. There is no way to delete a user, and `prisma.user.delete()` fails today on a foreign
key: seven relations reference `User` with no `onDelete` behaviour, so the row cannot be removed
while any of them exist. ADR-0038 called this out twice as the hole its own design had to avoid
deepening ("an audit log that is hard to erase would deepen a hole that is already open"), and
slice 4 (#555) shipped `deleteAuditDataForUser()` with no caller, because there was no deletion
flow to call it from. A real pilot with real students needs a working erasure path.

The hard part is not the FK. It is that **a `Match` is the record of something that happened to two
people.** The deleted user's account is theirs to erase; the other participant's history of their
own date is not. Cascading `Match` on user deletion would let one person erase another person's
past. So `Match` does not cascade, and the question becomes what the surviving rows point at once
one side is gone.

Two shapes were considered:

1. **Nullable `userAId`/`userBId`** plus a denormalised display name on `Match`. The more honest
   schema — "this match has one participant left" is a real state and the columns would say so.
   Rejected for cost, not for correctness: every read path that assumes a `Match` has two resolvable
   users (`getUserState`, `getMatchPhoto`, `blindDate.service`, `decision.service`,
   `scheduling.service`, the eval tracks, `/dev/match-pipeline`) would each need a defined
   behaviour for the half-null case, and each is a place a future reader forgets it.
2. **A single reserved tombstone `User` row** every departed side is repointed at. Chosen. The
   columns stay non-null, every existing read path keeps working unchanged, and the cost is one
   reserved row plus the rule that nothing may treat it as a person.

## Decision

**One reserved tombstone user; the departing side of a shared record is repointed at it; everything
the departing user owns alone is erased.**

1. **The tombstone** is a fixed-id `User` row (`DELETED_USER_ID`, a pinned UUID) with
   `email: "deleted-user@wingman.invalid"`, `name: "Deleted user"`, empty `phone`, and
   `matchingState: "IDLE"`. It is created lazily on the first deletion that needs it, never by a
   migration or the seed. It carries no `Profile` and no `WantedProfile`, so it cannot be
   negotiated over even if something did reach it.

   **`IDLE` is a starting value, not a defence — the tombstone is excluded by id.** An earlier
   draft of this ADR leaned on the state column: every candidate query selects on
   `matchingState: "WAITING"`, so an `IDLE` row can never be picked. That is true only while the
   column stays `IDLE`, and it does not. Four paths update _both_ participants of a `Match` by id
   and would happily write to the tombstone: `rejectMatch` (decision.service),
   `startTimeSelection` and `assignDate` (scheduling.service), and `handleNegotiationOutcome`
   (orchestration.service). The first fires on its own and is the common case, not an edge:
   a deleted user can never answer Yeah/Nah, so the decision window on their match always expires,
   and rejection sets both sides to `WAITING`. The tombstone would then be swept as a live seeker,
   accruing a `MatchAttempt` and audit rows per tick for an erased account.

   So the rule is: **exclude `DELETED_USER_ID` by identity, never by trusting its state.** Every
   "both participants" write filters the id list; the sweep's seeker query, both candidate pools,
   and `matchOneUser` itself (which `POST /:id/trigger-match` reaches with any id that resolves)
   exclude it explicitly. Nothing can overwrite an identity check; anything can overwrite a column.

2. **Erased outright** — the user's own data, gone with the row via `onDelete: Cascade`:
   `Profile`, `WantedProfile` (and both `rawTranscript`s), `PushToken` (these three already
   cascaded), plus `Notification`, `SeedTranscript`, `GoldenPair`, the departing user's own
   `FollowUp`, and the departing user's own `FeedbackRound` — including its `rawTranscript` and
   `delta`, which are their words about their own date. `InterviewSessionSnapshot` is deleted
   explicitly rather than by cascade: like the audit tables it deliberately carries no relation to
   `User` (ADR-0039), but unlike them it holds an in-progress interview's answers, so erasure must
   reach it. `AuditEvent` and `AgentCall` go through `deleteAuditDataForUser()` (ADR-0038) —
   one statement per table, still no relation to `User`.

3. **Retained, with the departing side anonymised** — repointed at the tombstone:
   `Match` (`userAId`, `userBId`, and `proposerId`, which is a plain string column holding a user
   id and would otherwise dangle) with its `deliberationLog`, `rationale` and scores; and
   `MatchAttempt`, which is metadata-only already. The other participant's `FollowUp` and
   `FeedbackRound` are untouched — they are separate rows keyed by their own `userId`, so nothing
   the surviving user wrote changes. Their `matchingState` is the one exception, and only for a
   date that had not happened yet: see §7.

4. **`GoldenPair` and `SeedTranscript` cascade rather than anonymise.** They are eval ground truth,
   not anyone's date history — a golden pair with a tombstone on one side is a broken fixture, not
   a preserved record.

   This cuts the opposite way to leaving `User.expectedMatches` alone (see Consequences), and the
   difference is what each option does to a _later_ eval run. A `GoldenPair` naming a tombstone
   cannot be scored at all: the pair has no second profile to compare, so keeping it turns every
   future Track 1 run into a run with a guaranteed failure in it. A stale id inside
   `expectedMatches` costs that user's precision@5 one slot and nothing else. Deleting a fixture
   that can no longer be evaluated is removing a broken row; rewriting `expectedMatches` would be
   editing the answer key of a still-valid one.

5. **`seedFixtures.ts` uses this same code path in a second mode.** The fixture teardown is not an
   erasure — it replaces a fixture user, and anonymising instead of deleting would leave a
   tombstoned `Match` behind on every `pnpm db:seed`. So `deleteUserAccounts()` takes a mode:
   `"anonymize"` (the endpoint) repoints shared records at the tombstone, `"purge"` (fixtures)
   deletes the shared `Match` rows and their children outright. Both modes share the same ordered
   teardown of everything the user owns alone, which is the part the old hand-rolled teardown got
   wrong: it handled `feedbackRound → followUp → match → user` and never `MatchAttempt`,
   `Notification`, `SeedTranscript` or `GoldenPair`, so it survived only because fixture users
   happened not to have those rows.

6. **The endpoint is gated on the account password.** `DELETE /api/users/:id` takes the account
   password in the body and bcrypt-checks it against `passwordHash` before anything is touched
   (401 on a mismatch, and on a passwordless row, exactly as `loginUser` treats one). A user id is
   not a secret — `GET /api/users/:id/state` returns `matchedWith`, the other participant's id —
   so a path parameter alone must never be enough to erase somebody, and this deletion is
   irreversible by design. This is the one place the POC's "don't over-engineer authentication"
   rule (CLAUDE.md §9) does not reach: every other route is a read or a self-scoped write.

7. **A departing user's upcoming matches are cancelled, releasing the counterparty.** Erasure
   alone would leave the other participant holding a live match against a row that can never
   answer Yeah/Nah, never pick a time and never show up — and at `DATE_ASSIGNED` nothing would
   ever move them again. So before the erasure, every `MATCHED` match of the departing user whose
   `dateTime` is null or still in the future is put through `rejectMatch`: the counterparty
   returns to `WAITING` exactly as they would for any other rejection, with no new notification
   type and no new screen. A match whose date has **already happened** is left untouched — it is
   the counterparty's record of a real date, and their debrief (which tunes their next match)
   still has to be possible afterwards.

8. **The deletion is audited before it erases, not after.** `USER_DELETED` joins the ADR-0038
   vocabulary with an empty payload, and the api service records it, erases the domain rows, then
   calls `deleteAuditDataForUser()` — which removes that event too. This is deliberate: an audit
   row keyed by a `userId` that no longer resolves is exactly the "delete by userId on two tables"
   promise ADR-0038 made, half-kept. The event exists for the duration of the request, so a crash
   mid-erasure leaves a trace of what was attempted, and nothing survives a completed one.

## The counter-argument this decision has to answer

`Match.deliberationLog` is agent-written text **about both people** — it quotes and characterises
the departing user's profile, not just the surviving one's. Retaining it under a tombstone means
text about a deleted person survives their deletion. This is the strongest argument against the
direction above and it is not dismissed:

- The surviving participant's record of their own date is not separable from it. The log _is_ the
  rationale for a match they were in; stripping it leaves them a row that says two people were
  paired and nothing about why.
- What survives is not linked to an identity. The tombstone has no name, email, phone, photo or
  profile, and the `userId` the log hangs off resolves to a row that is deliberately not a person.
  The log's prose describes traits without naming who held them.
- ADR-0007 and ADR-0027 already justify persisting the negotiation record, including for failed
  and abandoned negotiations.

The honest statement of the cost: **this is not erasure of every sentence about the departing
user — it is erasure of everything that identifies them.** If a pilot ever needs the stronger
promise, the smallest next step is scrubbing `deliberationLog` and `rationale` on matches whose
counterparty is the tombstone, which this decision leaves open rather than forecloses.

## Consequences

- **Deleting a user is not reversible and not partial.** There is no soft-delete flag, no grace
  period, and no way to reconstruct the account from what remains.
- **`Match` rows can now have a non-person on one side.** Every future read path must tolerate a
  participant with no `Profile` and no `WantedProfile`, and every new query that selects or
  updates users in bulk has to ask whether it means the tombstone. The existing ones are listed in
  Decision §1; the test that keeps the rule honest is "never moves the tombstone into the matching
  queue" in `decision.service.test.ts`.
- **`User.expectedMatches` on other users can name a deleted id.** It is a JSON array of ids, not
  an FK, and it is Track 1 eval ground truth — a deleted user leaves a stale id there, which reads
  as a candidate that will never be found. Deliberately out of scope: seeded eval users are not
  real accounts, and rewriting ground truth on deletion would silently change eval results.
- **A deleted user's id survives inside other users' `MatchAttempt.candidateScores`.** That column
  is JSON, so `candidateId` is not a foreign key and nothing repoints it — another seeker's attempt
  can name an id that no longer resolves. Same class as `expectedMatches` above, and accepted for
  the same reason: it is a bare uuid with no name, profile or contact attached, it is diagnostic
  history for the _other_ user's attempt, and rewriting stored JSON on deletion would edit the
  record of what the engine actually did. The `/dev/match-pipeline` page renders it as a truncated
  id and `orchestration.service` re-reads each candidate before negotiating, so a stale id is inert
  in both.
- **The tombstone is counted by any unfiltered `user.count()`.** None exists today on a path that
  matters (Track 1 counts with `expectedMatches: { not: null }`), but a future "how many users do
  we have" query has to exclude it.
- **Retention of the retained `Match` rows is still unanswered** — the sibling question to the
  90-day audit sweep, and Pilot Gate work (#435), not this issue's.
