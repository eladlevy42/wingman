# apps/mobile is pinned to Expo SDK 54, because iOS Expo Go cannot load anything newer

## Context

ADR-0032 §Decision-5 fixed the mobile dev loop as: "the iPhone runs the app via Expo Go over
LAN ... No Mac/Xcode required from the Windows dev machine." That loop is the only way anyone on
this two-person team sees the app on a real iPhone, since neither has a Mac and the iOS Simulator
does not exist on Windows.

Scaffolding `apps/mobile` (#436) initially landed on Expo SDK 57, the current release. Scanning the
dev server from a physical iPhone returned "Project is incompatible with this version of Expo Go".

Investigating rather than assuming a stale install:

- The App Store's Expo Go for iOS is **54.0.2**, published 2025-09-23. Verified identical across the
  IL, US, GB and DE storefronts, so it is not a regional rollout.
- The device in question runs iOS 26.6 and had that exact build. It was already up to date.
- The dev server's manifest advertised `sdkVersion: 57.0.0`; Expo Go 54.0.2 tops out at SDK 54.

Android was unaffected, and the reason is worth stating because it is easy to mistake for the
platforms behaving the same: `expo start --android` downloads an Expo Go build **matching the
project's SDK** and installs it over adb. iOS has no equivalent — Apple permits no sideloading, so
the App Store build is the only option available.

That leaves the SDK version and the iPhone dev loop in direct conflict. Only one can be had.

## Decision

**`apps/mobile` pins Expo SDK 54** (`expo ~54.0.x`, React 19.1.0, React Native 0.81.5), the newest
SDK iOS Expo Go can load.

The dev loop is the constraint, not the SDK. A newer React Native buys this project nothing it can
observe, whereas losing the iPhone loop costs the team the ability to look at the product they are
building on the device it ships to — on a dating app, where feel is the whole argument for going
native (ADR-0032 §Context), that is not a trade worth making for a version number.

Alternatives considered and rejected:

- **Stay on SDK 57, test on Android only.** Cheapest today. Rejected: it silently retires the
  iPhone half of the dev loop, and the divergence would be discovered late, by which point more code
  would assume it.
- **Stay on SDK 57, use an EAS development build for iPhone.** Technically correct and the eventual
  destination — ADR-0032 already schedules EAS dev builds at the Pilot Gate, since push
  notifications require them. Rejected _for now_: it pulls cloud builds and an Apple provisioning
  story into a scaffolding slice, and pilot-gate items are deliberately deferred until funding.

## Consequences

- Expo SDK upgrades are gated on iOS Expo Go, not on Expo's release schedule. Before raising the SDK,
  check the App Store's Expo Go version: `curl -s "https://itunes.apple.com/lookup?bundleId=host.exp.Exponent" | jq '.results[0].version'`
- iOS Expo Go has not been updated since 2025-09-23. If that freeze is permanent — Expo has been
  steering users toward development builds for some time — this pin cannot hold forever, and the
  Pilot Gate's EAS dev build becomes the moment the constraint lifts rather than merely the moment
  push notifications arrive.
- SDK 54 tolerates Node 20.12.2, whereas SDK 57 requires >= 20.19.4 and warns on every command. The
  downgrade removes that warning; it is a side effect, not a reason.
- `apps/web` still needs its React-types pin. SDK 54 brings `@types/react@19.1`, which is older than
  57's 19.2 but still React 19, so it leaks into `apps/web`'s React 18 build exactly as before.
- Android is unconstrained by this and can run any SDK, so an Android device or emulator remains the
  faster inner loop; the iPhone is the fidelity check.
