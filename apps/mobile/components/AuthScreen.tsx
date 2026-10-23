import type { ReactNode } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "~/components/ui/text";

/**
 * Shared frame for the onboarding screens (sign up, sign in, university
 * verification). Holds the three things all of them need and none of them
 * should re-solve: the safe-area top inset, a keyboard-avoiding scroll so a
 * field near the bottom of a long form stays reachable, and the top-anchored
 * `max-w-sm` column the web onboarding pages use.
 */
export function AuthScreen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView className="bg-background flex-1" edges={["top", "bottom"]}>
      {/* "padding" on Android too, not just iOS. Android used to resize its own
          window for the keyboard (adjustResize), which made KeyboardAvoidingView
          redundant there — but Expo SDK 54 turns on edge-to-edge, the window
          stops resizing, and without this the keyboard simply covers whatever is
          at the bottom of the form. */}
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <ScrollView
          className="flex-1"
          // Generous bottom padding so the last field and the CTA can still be
          // scrolled clear of the keyboard: KeyboardAvoidingView shrinks the
          // scroll viewport, it does not scroll the focused input into view.
          contentContainerClassName="grow px-8 pb-32 pt-[68px]"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View className="w-full max-w-sm self-center">
            <Text className="text-foreground text-[30px] font-bold tracking-[-0.9px]">{title}</Text>
            {subtitle && (
              <Text className="text-muted-foreground mt-4 text-base leading-6">{subtitle}</Text>
            )}
            <View className="mt-10 gap-3.5">{children}</View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
