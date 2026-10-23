import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { X } from "lucide-react-native";
import { NOTIFICATION_TEXT } from "@wingman/shared";
import { Text } from "~/components/ui/text";
import { useNotificationStore } from "~/hooks/useNotificationStore";
import { routeForBannerTap } from "~/lib/bannerRouting";
import { COLORS } from "~/lib/colors";

// CONTEXT.md: the banner auto-dismisses after 5 seconds. Dismissal advances the
// queue but leaves the badge alone — only a deliberate tap counts as read.
const AUTO_DISMISS_MS = 5000;

/**
 * The in-app notification banner (#439) — mobile counterpart of web's
 * NotificationBanner, behaviour ported rather than markup.
 *
 * Rendered once in the root layout, above the navigator, so it can appear over
 * whatever screen is showing. It draws its own top inset instead of sitting
 * inside a SafeAreaView, because it is a sibling of the whole navigator rather
 * than part of any screen.
 */
export default function NotificationBanner() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { activeNotification, dismissActive, clickActive } = useNotificationStore();

  useEffect(() => {
    if (!activeNotification) return;
    const timer = setTimeout(dismissActive, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
    // Keyed on the notification itself, not just its presence: when one banner
    // is replaced by the next in the queue, the new one gets its own full five
    // seconds rather than inheriting the remainder of the old timer.
  }, [activeNotification, dismissActive]);

  if (!activeNotification) return null;

  function handlePress() {
    if (!activeNotification) return;
    // Order matters: consume the notification first, so a destination that
    // re-renders this component does not find the same banner still active.
    clickActive();
    const destination = routeForBannerTap(activeNotification.type);
    if (destination) router.push(destination);
  }

  return (
    <View
      // z-50 alone is not enough on Android, where overlap is decided by
      // elevation rather than by paint order.
      className="bg-primary absolute left-0 right-0 top-0 z-50"
      style={{ paddingTop: insets.top, elevation: 8 }}
      accessibilityLiveRegion="assertive"
    >
      <View className="flex-row items-center gap-3 px-4 py-3">
        <Pressable
          onPress={handlePress}
          accessibilityRole="button"
          className="flex-1"
          testID="notification-banner"
        >
          <Text className="text-primary-foreground text-sm font-medium">
            {NOTIFICATION_TEXT[activeNotification.type]}
          </Text>
        </Pressable>
        <Pressable
          onPress={dismissActive}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          testID="notification-banner-dismiss"
          // Bigger than it looks: the X is 16px, which is well under the 44px
          // minimum a thumb can reliably hit.
          hitSlop={12}
        >
          <X size={16} color={COLORS.primaryForeground} />
        </Pressable>
      </View>
    </View>
  );
}
