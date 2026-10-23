# The user-facing client becomes a native Expo app in the monorepo, superseding the web-only rule

## Context

CLAUDE.md §9 banned mobile ("DO NOT build a mobile app (React Native/Expo). Use React DOM via
Vite") to keep the POC small. Two inputs changed:

1. The POC is now expected to grow directly into the MVP/pilot (~500 users, after funding), not be
   thrown away. A dating app pilot lives or dies on native feel — and Wingman's core surfaces are
   chat (Barney interviews, pitch, debrief) and photo capture, exactly where WebView-based options
   feel worst (keyboard jank, scroll physics).
2. A wrapper (Capacitor) would ship this week but near-guarantees a React Native rewrite later,
   paying for both. Both app stores accept Capacitor apps, so store availability was not the
   differentiator — product feel was.

Alternatives considered and rejected:

- **Mobile-first PWA** — no store presence, no reliable push on iOS, still a website.
- **Capacitor wrapper** — distribution without native feel; rewrite cost merely deferred to the
  worst possible moment (mid-pilot).
- **Separate repo for the RN app** — kills the shared-by-import Zod boundary (`packages/shared`);
  schema drift or a publishing pipeline, both wrong for a two-person team.

## Decision

1. **`apps/mobile` (Expo / React Native) joins the existing Turborepo monorepo**, importing
   `packages/shared` (Zod schemas) and `packages/database` (types) exactly like `apps/web` does.
   This deliberately supersedes the CLAUDE.md §9 mobile ban, which is amended alongside this ADR.
2. **`apps/web` survives for now (coexist)** — it keeps the dev/audit surfaces
   (`/dev/match-pipeline`, `BarneyChatHarness`) and the current user flow. Whether it shrinks to
   dev-tooling-only is a pilot-gate decision, not today's.
3. **Styling: NativeWind + react-native-reusables** — Tailwind syntax and ShadCN-shaped components,
   keeping the mental model identical to `apps/web` for the same two developers.
4. **Vertical slices, in order:** (1) Register → Phase 1 interview chat, (2) Phase 2, (3)
   Waiting/match state, (4) Pitch + Blind Date, (5) Debrief — deferred, not cut; it is the
   FeedbackDelta loop that makes the product self-improving.
5. **Dev loop:** api stays local (SQLite, localhost); the iPhone runs the app via Expo Go over LAN
   (API client targets the dev machine's LAN IP, which Expo exposes at runtime; `--tunnel` for
   off-network demos). No Mac/Xcode required from the Windows dev machine.
6. **The Pilot Gate** — recorded now, executed only when funding lands, so it is not re-litigated:
   - Backend host: one AWS EC2 `t3.small` (~$15/mo; free-tier `t3.micro` to start), Ubuntu with
     nginx and pm2/systemd, deploy via GitHub Action. Chosen over Railway/Fly (equally capable,
     ~same $5–20/mo band) because the team explicitly wants to learn EC2. ECS is explicitly out of
     scope until there is something to orchestrate.
   - Database/photos: Supabase Postgres + Storage (Prisma provider swap; photos move off
     base64-in-SQLite). This will supersede the §9 SQLite-only rule _at the pilot gate, not before_.
   - Push notifications: Expo push service + a device-token table + api event hooks for
     MATCH_FOUND / DATE_ASSIGNED / DEBRIEF_NUDGE. Requires an EAS development build (push does not
     work in Expo Go on iOS). The pilot must not launch without this — with the app closed and no
     push, the Decision Window auto-Nah is a silent product-killing failure.
   - `DECISION_WINDOW_MINUTES=1440` (24h) for the pilot.
   - An LLM cost-ceiling analysis (negotiation sweeps scale with the WAITING-pool crossproduct, not
     linearly with users) before opening the gates.

## Consequences

- Every future user-facing feature is built in `apps/mobile`; `apps/web` receives dev-tooling only.
- The 17 web pages' markup/styles do not port; hooks logic, the API client shape, all Zod schemas,
  and 100% of the backend survive unchanged.
- Playwright E2E does not cover RN. Mobile E2E (Maestro/Detox) is deferred; until then, evidence for
  mobile slices is screenshots/screen-recordings from the device, kept in the same
  `docs/evidence/[issue]/` convention.
- Known accepted risk until the pilot gate: in-memory sessions (docs/adr/0003) die on api restart —
  acceptable for demo-phase, revisit only if it bites.
