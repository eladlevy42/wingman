# Mobile component tests run on Jest + RNTL, alongside Vitest rather than replacing it

## Context

`apps/mobile` had no rendering tests of any kind (#507). `vitest.config.ts` put rendering out of
scope on purpose during the scaffold slice (#436), aliasing `react-native` to a hand-written stub so
the plain-TypeScript logic could be tested under Node. That was a reasonable call when mobile was a
scaffold. It stopped being reasonable once mobile became the user-facing client (ADR-0032).

The cost was visible across a whole batch of PRs: #493/#499, #494/#500, #495/#501, #496/#502. In
each, the issue named a **mobile** bug, the fix touched both clients, and every test and screenshot
was `apps/web`. The web half was verified; the half the issue was filed about was not. The
`review` skill had a rule acknowledging this — device evidence, or an explicit statement that the
device run is outstanding — which is an honesty mechanism, not a test.

The surfaces with no automated coverage at all are component-level, not flow-level: `BarneyChat`'s
`maxLength` and counter, `ScreenFailure`, `PhotoStep`, the resume path. That points at a component
harness before an E2E one.

The open question was not _which library_ — React Native Testing Library is the only real candidate —
but **which runner**, given the repo is Vitest everywhere else. A single runner was the preferred
outcome, so RNTL-under-Vitest was attempted first and in earnest.

### What the Vitest attempt actually hit

Not a matter of configuration polish. In order:

1. `babel-preset-expo` compiles ESM to CJS, which Vitest rejects outright. Fixed with
   `disableImportExportTransform`.
2. `react-native` is externalized by Vitest and loaded natively by Node, which cannot parse its
   Flow-typed source. `server.deps.inline` did not pull it in; a bespoke `enforce: "pre"` Babel
   plugin was needed to intercept it at all.
3. With the transform finally reaching `react-native/index.js`, that file mixes `import typeof`
   Flow syntax with lazy `require()` calls behind `Object.defineProperty` getters, and the
   ESM/CJS interop of the result failed to parse. This is the point the attempt was abandoned.

Meanwhile RNTL's own `peerDependencies` name `jest >= 29`, and `jest-expo` — which Expo maintains
specifically to assemble a working React Native module surface — cleared items 1-3 with no bespoke
code. Two configuration lines were still needed, both consequences of pnpm and neither of them
research (see Consequences).

A second, unrelated constraint: RNTL v14 requires the new `test-renderer` package, which needs
React >= 19.2. ADR-0033 pins mobile to Expo SDK 54 and therefore React 19.1. **RNTL v13** is the
version this repo can run, and it uses `react-test-renderer`.

## Decision

**Mobile component tests run under Jest (`jest-expo` preset) with React Native Testing Library v13.
Vitest keeps everything else, including mobile's logic tests.**

The two suites are split by file extension, which is the whole coordination mechanism:

| Extension    | Runner      | Scope                                              |
| ------------ | ----------- | -------------------------------------------------- |
| `*.test.ts`  | Vitest      | Plain TypeScript — api client, SSE parser, routing |
| `*.test.tsx` | Jest + RNTL | Anything that renders                              |

Vitest's `include` takes `.test.ts` only and Jest's `testMatch` takes `.test.tsx` only, so neither
runner can collect the other's files. `pnpm --filter @wingman/mobile test` runs both.

Accepting a second runner in one workspace is the real cost of this decision, and it is accepted
deliberately: the alternative was a bespoke Babel/Vite pipeline for React Native that this
two-person team would own and re-debug on every Expo upgrade, in exchange for runner uniformity that
buys nothing a developer can observe.

Alternatives considered and rejected:

- **RNTL under Vitest (one runner).** The preferred outcome, attempted first. Rejected on evidence,
  not principle — see the three failures above. It would have left the team maintaining a private
  transform pipeline for React Native's Flow source, unsupported by both Expo and RNTL.
- **Maestro.** YAML flows, no native build step, works against Expo Go. Rejected as the _first_
  move, not on merit: the recurring gaps are component-level, and Maestro's assertions are the
  weakest of the three. It remains the natural choice when flow coverage is what is missing.
- **Detox.** Real gray-box control and much stronger assertions. Rejected for now: it needs a dev-client
  build and meaningful CI setup, which is Pilot-Gate-shaped work (ADR-0032 §6) for a gap that is not
  flow-shaped.
- **`react-native-web` + jsdom + `@testing-library/react`.** Would have kept one runner and avoided
  the Flow problem entirely. Rejected on fidelity: it tests a different renderer than the one that
  ships, which for a native app makes a passing test the wrong kind of reassurance.

## Consequences

- `apps/mobile` has two test runners. Anyone adding a mobile test picks by extension: does it
  render? `.test.tsx`. Otherwise `.test.ts`.
- The `review` skill's "device evidence, or say it is outstanding" rule is replaced for
  component-level changes: a mobile component change is expected to carry a `.test.tsx`. Device
  evidence is still what flow-level and visual changes need — this harness does not render pixels,
  and nothing here covers navigation, native modules, or layout.
- CI now runs `pnpm test`. It previously ran only `format:check`, `lint` and `typecheck`, so **no
  workspace's tests ran in CI at all** — a red suite could reach main as long as it typechecked.
  That is fixed as part of this change and is a repo-wide improvement, not a mobile one.
- Two pnpm-specific configuration lines are load-bearing and will look arbitrary to anyone reading
  `jest.config.js` without this context:
  - `transformIgnorePatterns` is anchored on `node_modules/.pnpm/` rather than jest-expo's default.
    pnpm nests each package a second time under its own `node_modules/`, and the default pattern
    re-tests at that inner segment — so a package it allowed through at `.pnpm/` gets ignored after
    all. `@rn-primitives/slot` arriving as raw JSX is what surfaced this.
  - `lucide-react-native` is mapped to its CJS build. Its `react-native` export condition points at
    one ESM barrel of every icon, which Jest cannot `require` and Babel spends ~45s compiling. The
    mapping takes a cold run from ~49s to ~8s.
- RNTL is pinned to v13 by ADR-0033's React 19.1 pin. Raising the Expo SDK is what unblocks RNTL
  v14, so these two upgrades are coupled and should move together.
