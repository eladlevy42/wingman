import { useEffect } from "react";
import { useRouter } from "expo-router";
import * as Notifications from "expo-notifications";
import { routeForPushData } from "~/lib/pushRouting";
import { loadUser } from "~/lib/session";

/**
 * Routes a tapped push notification to the right screen (#479).
 *
 * Mounted once in the root layout rather than per screen: a tap can arrive
 * while any screen is showing, and — when the app was killed — before any
 * screen has mounted at all.
 *
 * The signed-in check is made when the tap happens, not when the listener is
 * registered. A notification can sit on the lock screen for hours; by the time
 * someone taps it they may have signed out on this device, and sending them
 * into another account's match would be the worst possible outcome of a feature
 * whose whole job is to bring people back into the app.
 */
export function usePushNotificationTaps(): void {
  const router = useRouter();

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void (async () => {
        const user = await loadUser();
        const destination = routeForPushData(
          response.notification.request.content.data,
          user !== null
        );
        // null means the payload was unrecognised — an older build tapping a
        // type added later, or a malformed data blob. Leaving the user where
        // they are beats navigating somewhere arbitrary.
        if (destination) router.replace(destination);
      })();
    });

    return () => subscription.remove();
  }, [router]);
}
