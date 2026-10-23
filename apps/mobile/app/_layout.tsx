import "../global.css";
import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import NotificationBanner from "~/components/NotificationBanner";
import { COLORS } from "~/lib/colors";
import { configureNotificationHandler } from "~/lib/push";
import { useNotificationPoll } from "~/hooks/useNotificationPoll";
import { usePushNotificationTaps } from "~/hooks/usePushNotificationTaps";
import { useScreenTracking } from "~/hooks/useScreenTracking";
import { startTelemetry } from "~/lib/telemetry";

// Set once at module scope, not in an effect: a notification can be delivered
// before React has mounted anything, and expo-notifications consults whatever
// handler is installed at that moment.
configureNotificationHandler();

/**
 * Root layout for the whole app.
 *
 * Every screen draws its own safe-area frame (the chat has to, because its
 * composer sits on the home indicator), so the navigator's header is off
 * everywhere — a native header would double up on the titles the screens
 * already render.
 */
export default function RootLayout() {
  // Tapping a push notification navigates from here, because a tap can land
  // before any screen has mounted (#479).
  usePushNotificationTaps();
  // Both of these are global rather than per screen (#439), and they have to
  // be: the foreground handler now suppresses the OS banner in favour of the
  // in-app one, so anything mounted more narrowly would mean notifications
  // arriving on an unwatched screen being shown by neither. See
  // hooks/useNotificationPoll for the full reasoning.
  useNotificationPoll();
  // Screen views for every route, and the flush timer + background hook that
  // get them to the API (#554). Both live here for the same reason the two
  // above do: a screen added later is covered without being remembered.
  useScreenTracking();
  useEffect(() => startTelemetry(), []);

  return (
    // SafeAreaProvider must wrap everything: it is what publishes the insets
    // that SafeAreaView and useSafeAreaInsets read further down the tree.
    <SafeAreaProvider>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: COLORS.background } }}
      />
      {/* After the navigator, so it paints over whichever screen is showing. */}
      <NotificationBanner />
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
