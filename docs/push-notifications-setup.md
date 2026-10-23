# Push notifications — setup

Everything the code needs is in the repo. What is **not** in the repo, and cannot be, is
credentials. This is the one-time setup that turns the code on.

Related issues: #444 (parent), #477 / #478 / #479 (code, done), #480 (builds), #518 (iOS
prerequisites).

## How delivery works

```
match/date/followup  ->  notificationService.send()  ->  Notification row  (polled by web)
                                                     \
                                                      ->  pushService.sendToUser()  ->  Expo  ->  APNs / FCM
```

The persisted `Notification` row is written **first and unconditionally**. Push is an addition,
never a replacement: a user with no registered device, or one whose push fails, still sees the
notification the next time the app polls. Nothing is lost when push is off — which is exactly the
state a fresh clone is in.

Expo's push service fronts both APNs and FCM, so `apps/api` has no per-platform code. iOS and
Android differ only in which credentials are configured on the EAS project.

> **Run every command below from `apps/mobile`, not the repo root.** `app.json` and `eas.json` both
> live there. Run from the root and `eas init` links the wrong directory and writes a stub
> `app.json` beside `package.json`, while `eas credentials` fails outright with
> `eas.json could not be found`.
>
> ```bash
> cd apps/mobile
> ```

## 1. EAS project (required for either platform)

```bash
pnpm --filter @wingman/mobile exec eas init
```

This writes `extra.eas.projectId` into `app.json`. **`getExpoPushTokenAsync` cannot mint a token
without it** — until this is done, `registerForPushNotifications` logs a warning and returns null,
which is why push silently does nothing on a fresh checkout rather than crashing.

Keep the resulting `projectId` in your local checkout. Do not commit a real EAS project id.

## 2. Android (free, same day)

1. Create a Firebase project at console.firebase.google.com and add an **Android** app whose
   package name is exactly:

   ```
   com.wingman.app
   ```

   That is `expo.android.package` in `app.json`. Firebase ties `google-services.json` to this
   string, so a mismatch produces a build that installs fine and then silently never receives a
   push — the worst failure mode available here. `expo.ios.bundleIdentifier` is the same value.

2. Download `google-services.json` into `apps/mobile/`.
3. Add `"googleServicesFile": "./google-services.json"` under `expo.android` in `app.json`.
   _It is deliberately not there now_ — Expo fails the build on a `googleServicesFile` that points
   at a file which does not exist, so committing the reference before the file would break every
   build for anyone who cloned the repo.
4. In the Firebase console, **Project settings → Service accounts → Generate new private key**,
   then upload that JSON to Expo:

   ```bash
   pnpm --filter @wingman/mobile exec eas credentials
   ```

   Choose Android → _FCM V1 service account key_.

5. Build and install:

   ```bash
   pnpm --filter @wingman/mobile exec eas build --platform android --profile development
   ```

### Which of these two files is a secret

They are not the same kind of thing, and treating them alike breaks one or leaks the other.

- **`google-services.json` — commit it.** EAS builds from a clone of this repo, so a build cannot
  see a file that git does not carry, and the result is an app that mints push tokens and then
  never receives anything. It is also not a secret: it is packaged inside the `.apk`, so anyone who
  installs the app already has it. The Android api key it holds is restricted by package name and
  signing certificate, which is the control that actually applies. (This repo is private in any
  case. If it ever goes public, that reasoning still holds — but review the key's restrictions in
  the Google Cloud console first.)
- **The service account key — never commit it.** This one is a real private key: it authorises
  sending push to every device registered to the project. It is uploaded to EAS and never read by
  the app. `apps/mobile/.gitignore` covers both names Firebase gives it
  (`*firebase-adminsdk*.json`, `service-account*.json`).

If you would rather not commit `google-services.json` at all, EAS supports file-type environment
variables: upload it as one and point `googleServicesFile` at the variable. That is more moving
parts for no security gain here, which is why this repo does not do it.

## 3. iOS

Blocked on procurement, not engineering — see **#518** for the full checklist. In short: an Apple
Developer membership ($99/yr), a physical iPhone (the Simulator cannot receive remote push under
any configuration), an APNs `.p8` key, and the device registered via `eas device:create`.

The iOS code path is written and typechecked but **unverified**. `app.json` already declares
`aps-environment: development`.

## 4. Server (optional, recommended)

Set `EXPO_ACCESS_TOKEN` in the api's environment. Without it, anyone who learns a device's Expo
push token can send notifications to that device. Create one at expo.dev → Account → Access
Tokens.

## Verifying it works

Registration is silent by design, so check the device row rather than the UI:

```bash
pnpm --filter @wingman/database exec prisma studio
```

A `PushToken` row appears after signing in on a build made in step 2. Then trigger a real event —
the manual find-match trigger produces `MATCH_FOUND` — and the notification should arrive **with
the app closed**.

If no row appears, the api logs the reason: `push: no EAS project id`, `push: notification
permission not granted`, or a registration failure.

## Known limitations

- **Expo Go cannot receive remote push.** Expo removed it in SDK 53 and this project is on SDK 54.
  A development build is mandatory. Everything else in the app still works in Expo Go — push is
  the one thing that does not.
- **Android emulators need a Google Play system image.** Registration is deliberately not gated on
  `Device.isDevice` precisely so an emulator can be used; a Play-less image still cannot receive
  FCM.
- **Receipts are not polled.** Ticket-level `DeviceNotRegistered` errors prune the token
  immediately, which covers uninstalls. Expo's asynchronous receipts endpoint, which reports
  failures that only surface after the push was accepted, is not read.
