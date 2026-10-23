# @wingman/mobile

The native Expo / React Native client — the user-facing Wingman app (see
[docs/adr/0032](../../docs/adr/0032-native-mobile-app-expo-in-monorepo.md)).
`apps/web` remains the dev/audit surface.

As of slice 1 (#437) the app runs the real onboarding path: sign up, sign in,
university verification, and the Phase 1 "grill me" interview with Barney,
ending with the profile saved. Everything after Phase 1 currently lands on a
placeholder screen — Phase 2 is #438, the waiting screen #439.

It talks to `apps/api` over the LAN. The base URL is derived from the address
Expo serves the bundle from (`lib/apiBaseUrl.ts`), so nothing needs editing when
your network changes. Set `EXPO_PUBLIC_API_URL` to override it — needed for
`--tunnel` (the tunnel host does not serve the api) or to point at a different
backend.

## The Expo Go dev loop

You need a physical phone. There is no iOS Simulator on Windows, and the
project is not set up for an EAS dev build — Expo Go over LAN is the loop.

If Expo Go shows **"Project is incompatible with this version of Expo Go"**, the
project's SDK has drifted above what the store build supports — see the SDK
gotcha at the end of this file. It is not a stale install.

1. Install **Expo Go** from the App Store / Play Store.
2. Put the phone on **the same Wi-Fi network** as your dev machine.
3. From the repo root:

   ```bash
   pnpm --filter @wingman/mobile dev
   ```

4. Scan the QR code Metro prints with the Camera app (iOS) or from inside Expo
   Go (Android).

The bundle takes ~30–60s the first time. Saving a file hot-reloads it.

### If the QR code does not render

Some terminals — and any non-interactive shell — will not draw the QR block. Get
your LAN IP and type the URL into Expo Go by hand:

```bash
ipconfig
```

Take the IPv4 address of your active Wi-Fi adapter (something like
`192.168.10.5`) and enter `exp://<that-ip>:8081` in Expo Go.

### If it hangs on "Downloading JavaScript bundle"

Almost always Windows Firewall blocking Node on the private network. Confirm by
opening `http://<your-lan-ip>:8081` in the phone's browser — if that does not
return a page, the phone cannot reach Metro at all.

Fix it either by allowing Node.js through the firewall for **private** networks
(Windows Security → Firewall & network protection → Allow an app), or by
skipping the LAN entirely:

```bash
pnpm --filter @wingman/mobile dev -- --tunnel
```

`--tunnel` routes through Expo's relay, so it works across networks and behind
firewalls. It is noticeably slower — use it as a fallback, not a default.

### Android emulator (no phone needed)

An emulator is the only way to see the app without a physical device — the iOS
Simulator is macOS-only, but the Android emulator runs fine on Windows. It needs
a JDK and the Android SDK, neither of which requires admin rights if you avoid
the MSI installers:

```bash
# 1. Portable JDK 21 - extract, do not install
#    https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip
# 2. Android command-line tools - extract to <SDK>/cmdline-tools/latest
#    https://developer.android.com/studio#command-tools
# 3. Then, with JAVA_HOME and ANDROID_HOME set:
android emulator create medium_phone   # downloads emulator + system image (~2GB)
android emulator start medium_phone
```

`android` is the current CLI; it replaced `sdkmanager`/`avdmanager`, and it
resolves the SDK licences itself rather than needing `--licenses`.

With the emulator running, `pnpm --filter @wingman/mobile dev -- --android`
fetches Expo Go, installs it on the AVD, and opens the app. `adb` also gives you
a scriptable device, which is how the evidence screenshots in
`docs/evidence/436-scaffold-apps-mobile/` were captured:

```bash
adb exec-out screencap -p > shot.png
```

The AVD is created with `hw.keyboard=yes`, which makes Android suppress the
on-screen keyboard in favour of your physical one — so keyboard-occlusion bugs
cannot be reproduced. To test them, set `hw.keyboard=no` in
`~/.android/avd/<name>.avd/config.ini` and restart the emulator. Confirm a real
IME is up with:

```bash
adb shell dumpsys input_method | grep mInputShown
```

## Tests

```bash
pnpm --filter @wingman/mobile test
```

Vitest covers the plain-TypeScript client logic — the api client, the SSE
parser, session storage, and the routing/formatting helpers. There is no React
Native renderer in the test setup on purpose; the native modules those files
import (`expo-constants`, AsyncStorage) are aliased to stubs in `test/stubs/`,
which is what makes them runnable under Node at all.

### Pointing the emulator at the api

The emulator is not on your LAN, so the derived base URL will not reach the api
by itself. Forward both ports over adb before opening the app — Metro so the
bundle loads from `localhost`, and the api so the derived
`http://localhost:3001` resolves to your machine:

```bash
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3001 tcp:3001
```

## Layout

| Path                 | What it is                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `app/`               | Expo Router routes — one file per screen                          |
| `components/`        | Shared UI: `BarneyChat`, `AuthScreen`, `FormField`                |
| `components/ui/`     | react-native-reusables components, owned by this repo (see below) |
| `hooks/`             | `useBarneyChat` (the conversation engine), `useKeyboardVisible`   |
| `lib/`               | api client, session storage, SSE parsing, routing helpers         |
| `lib/utils.ts`       | `cn()` — same helper as `apps/web/src/lib/utils.ts`               |
| `test/stubs/`        | Node stand-ins for native modules, used by Vitest only            |
| `global.css`         | Design tokens, mirrored from `apps/web/src/index.css`             |
| `tailwind.config.js` | Token names, mirrored from `apps/web/tailwind.config.js`          |
| `metro.config.js`    | pnpm-workspace resolution + the NativeWind wrapper                |
| `components.json`    | Config the react-native-reusables CLI reads                       |

### Adding a react-native-reusables component

react-native-reusables is a **registry, not a runtime dependency** — the CLI
copies source into `components/ui/` and this repo owns it from then on, exactly
like ShadCN in `apps/web`. To add one:

```bash
npx @react-native-reusables/cli@latest add card
```

Run it from `apps/mobile`. Any dependency the component needs (`@rn-primitives/*`
and friends) gets installed into this workspace automatically.

### Design tokens

The token **values** live in `global.css` and the token **names** in
`tailwind.config.js`, both mirrored by hand from `apps/web`. They are duplicated
rather than imported because `apps/web/src/index.css` also carries web-only base
rules (`body`, the global `border-border` reset) that mean nothing in React
Native. **If you change a token in `apps/web`, change it here too.**

There is no dark palette yet. The `dark:` variants inside the
react-native-reusables components compile but never match.

Because of that, `app.json` pins `"userInterfaceStyle": "light"`. Leaving it on
`"dark"` would not show up in the Expo Go loop above — Expo Go ignores the flag,
it only applies at native-build time — but in a dev-client or production build it
forces dark appearance, so `<StatusBar style="auto" />` would paint white
status-bar icons onto the white `--background` and the clock and battery would
vanish. Flip it back to `"dark"` (or `"automatic"`) in the same change that adds
a `.dark` token block, not before.

## Gotchas specific to this monorepo

- **`react-native-css-interop` is a direct dependency on purpose.** NativeWind's
  `jsxImportSource` rewrites JSX to import it, but it is only a _transitive_ dep
  of `nativewind` — under pnpm that is not resolvable from `apps/mobile`, and
  Metro fails with `Unable to resolve module react-native-css-interop/jsx-runtime`.
  Do not "clean it up". For the same reason `nativewind` is pinned to an
  exact version rather than a caret range: the two must move together. If a
  future `pnpm update` lifted `nativewind` to a minor wanting
  `react-native-css-interop@^0.3`, you would get two copies — Babel's rewritten
  JSX resolving the pinned 0.2.6 while `nativewind` registers compiled styles
  into its own nested copy. There is no resolution error and no build failure;
  every `className` simply stops applying.
- **`metro.config.js` deliberately does not set `disableHierarchicalLookup`,**
  even though Expo's monorepo guide recommends it. That guide assumes flat
  Yarn/npm hoisting; pnpm nests dependencies behind symlinks in
  `node_modules/.pnpm` and needs the upward walk.
- **`packages/shared` ships raw TypeScript** (`"main": "./src/index.ts"`, no
  build step), so Metro transpiles it. That is why `watchFolders` includes the
  workspace root — without it, edits there would not trigger a reload.
- **The Expo SDK is pinned to 54 on purpose, and upgrading it is not routine.**
  iOS Expo Go has been frozen at `54.0.2` since 2025-09-23 and cannot load a
  newer SDK, which would silently cost the iPhone dev loop above. Android is
  unaffected — `expo start --android` sideloads an Expo Go build matching the
  project's SDK, which iOS cannot do. Before raising the SDK, check what the App
  Store actually has:

  ```bash
  curl -s "https://itunes.apple.com/lookup?bundleId=host.exp.Exponent" | jq '.results[0].version'
  ```

  See [docs/adr/0033](../../docs/adr/0033-mobile-pinned-to-expo-sdk-54-for-ios-expo-go.md).
