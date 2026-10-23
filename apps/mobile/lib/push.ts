import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { PushTokenRecordSchema, type PushPlatform } from "@wingman/shared";
import { apiRequest, apiRequestNoContent } from "./api";

// Android suppresses heads-up notifications for any app that has not declared a
// channel with high importance — the push arrives, is recorded, and is silently
// filed away where nobody sees it. Registered before the token so the very
// first notification the app ever receives already has somewhere to land.
const ANDROID_CHANNEL_ID = "default";

function platform(): PushPlatform {
  return Platform.OS === "ios" ? "ios" : "android";
}

/**
 * EAS project id, which `getExpoPushTokenAsync` requires and cannot infer.
 *
 * Read from both places Expo puts it: `expoConfig.extra.eas` in a dev build,
 * `easConfig` in some Expo Go/EAS Update contexts. Absent entirely until
 * `eas init` has been run against the project (#480), which is exactly the
 * state a fresh clone is in — hence a null return rather than a throw.
 */
function easProjectId(): string | null {
  const fromExtra = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  const fromEasConfig = Constants.easConfig?.projectId;
  if (typeof fromEasConfig === "string" && fromEasConfig.length > 0) return fromEasConfig;
  return null;
}

/**
 * How a notification behaves when it arrives while the app is open.
 *
 * Nothing OS-drawn, as of #439: the in-app banner now exists, and showing both
 * would mean the same match announced twice, one of them over a screen already
 * saying it. `shouldShowList: true` still files the notification in the tray,
 * which is a different thing from interrupting — it is what lets someone scroll
 * back to a notification they glanced at and dismissed.
 *
 * The in-app banner is only equivalent because it is mounted globally, in the
 * root layout, and fed by a poll that runs on every screen. Narrowing either of
 * those turns this into a silent drop.
 *
 * Backgrounded and killed apps are unaffected — this handler only runs for a
 * notification delivered to a foregrounded app.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Asks for permission, obtains an Expo push token, and registers it against the
 * user (#479).
 *
 * Returns the token on success and null on every failure — a denied permission,
 * a missing EAS project, an emulator that cannot mint one, an api that is not
 * reachable. None of those are errors the caller should handle: push is an
 * enhancement over the persisted Notification rows, which keep working on their
 * own. Throwing here would take down a login over an optional feature.
 *
 * Safe to call on every launch. The api upserts on the token, so re-registering
 * costs one row update.
 */
export async function registerForPushNotifications(userId: string): Promise<string | null> {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name: "Wingman",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#e94f7c",
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) {
      console.warn("push: notification permission not granted");
      return null;
    }

    const projectId = easProjectId();
    if (!projectId) {
      // Expected on any checkout where `eas init` has not been run. Says so
      // plainly rather than surfacing Expo's own opaque error.
      console.warn("push: no EAS project id — run `eas init` (see #480). Skipping registration.");
      return null;
    }

    // Deliberately not gated on `Device.isDevice`. An Android emulator running
    // a Google Play system image can receive FCM perfectly well, and that is
    // the only surface iOS-less development has for verifying push at all
    // (#518). iOS simulators genuinely cannot, and fail in the catch below.
    if (!Device.isDevice) {
      console.warn(
        "push: not a physical device — this only works on an Android emulator with Play Services"
      );
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

    await apiRequest(`/api/users/${userId}/push-tokens`, {
      method: "POST",
      body: { token, platform: platform() },
      schema: PushTokenRecordSchema,
      fallbackErrorMessage: "Could not register this device for notifications.",
    });

    return token;
  } catch (error) {
    console.warn("push: registration failed:", error);
    return null;
  }
}

/**
 * Drops this device's registration, so a signed-out phone stops receiving
 * another account's notifications.
 *
 * Swallows failures for the same reason as registration: this runs inside sign
 * out, and a user must always be able to sign out. The api-side delete is
 * idempotent, so a retry on the next launch costs nothing.
 */
// Sign-out waits on this, and the mobile api client has no request timeout, so
// a device on a dead network would otherwise sit on a spinner until the OS
// gives up — a minute or more. Losing the unregistration is the lesser failure:
// the row is re-pointed at whoever signs in next on this device anyway, because
// register() upserts on the token.
const UNREGISTER_TIMEOUT_MS = 3000;

export async function unregisterPushNotifications(userId: string): Promise<void> {
  try {
    const projectId = easProjectId();
    if (!projectId) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await Promise.race([
      apiRequestNoContent(`/api/users/${userId}/push-tokens`, {
        method: "DELETE",
        body: { token },
        fallbackErrorMessage: "Could not unregister this device.",
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("unregister timed out")), UNREGISTER_TIMEOUT_MS)
      ),
    ]);
  } catch (error) {
    console.warn("push: unregistration failed:", error);
  }
}
