import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { NOTIFICATION_TEXT } from "@wingman/shared";
import { Text } from "~/components/ui/text";
import { useNotificationStore } from "~/hooks/useNotificationStore";

/**
 * The App Nav (#439) — mobile counterpart of web's AppNav: the Wingman mark
 * plus the Notification Badge and the Notification History behind it.
 *
 * Per CONTEXT.md this belongs only to the Waiting screen (and Pitch, when #440
 * lands) — never onboarding or the interviews. That is why it is a component a
 * screen opts into rather than something the root layout draws. The banner, by
 * contrast, is global; see hooks/useNotificationPoll for why the two differ.
 */
export default function AppNav() {
  const { badgeCount, notifications, markAllViewed } = useNotificationStore();
  const [isOpen, setIsOpen] = useState(false);

  function handleOpen() {
    setIsOpen(true);
    // Opening the history clears the badge but deliberately touches neither the
    // queue nor the active banner (CONTEXT.md) — seeing that something arrived
    // is not the same as acting on it.
    markAllViewed();
  }

  return (
    <View className="border-border flex-row items-center justify-between border-b px-4 py-3">
      <View className="flex-row items-center gap-2">
        <View className="bg-brand h-2 w-2 rounded-full" />
        <Text className="text-primary text-lg font-semibold">Wingman</Text>
      </View>

      <Pressable
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={
          badgeCount > 0 ? `Notifications, ${badgeCount} unread` : "Notifications"
        }
        testID="notification-history-trigger"
        hitSlop={8}
        className="flex-row items-center gap-2"
      >
        <Text className="text-muted-foreground text-sm">Notifications</Text>
        {badgeCount > 0 && (
          <View
            className="bg-destructive h-5 min-w-5 items-center justify-center rounded-full px-1"
            testID="notification-badge"
          >
            <Text className="text-destructive-foreground text-xs font-bold">
              {/* Matches web: the badge is a signal, not a counter, so it stops
                  growing the layout past two glyphs. */}
              {badgeCount > 9 ? "9+" : badgeCount}
            </Text>
          </View>
        )}
      </Pressable>

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsOpen(false)}
      >
        {/* The backdrop is the dismiss target — RN has no click-outside, so the
            panel sits inside a full-screen pressable and stops the press from
            reaching it. */}
        <Pressable
          className="flex-1 bg-black/30"
          onPress={() => setIsOpen(false)}
          accessibilityLabel="Close notifications"
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            className="bg-card border-border mx-4 mt-20 max-h-96 rounded-2xl border p-2"
            accessibilityLabel="Notifications"
            testID="notification-history"
          >
            {notifications.length === 0 ? (
              <Text className="text-muted-foreground px-2 py-3 text-sm">No notifications yet.</Text>
            ) : (
              <ScrollView>
                {/* Most recent first — the store keeps them oldest-first. */}
                {[...notifications].reverse().map((notification) => (
                  <View key={notification.id} className="rounded-xl px-2 py-2">
                    <Text className="text-foreground text-sm">
                      {NOTIFICATION_TEXT[notification.type]}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
