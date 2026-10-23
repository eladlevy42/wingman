import { ActivityIndicator, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS } from "~/lib/colors";

/**
 * Placeholder for a screen that is deciding whether it may render at all —
 * see useGuardedRoute. Deliberately says nothing: a guard that is still
 * checking has nothing true to tell the user yet, and the screens this stands
 * in for made claims ("Your profile is saved") that turned out to be false for
 * the person reading them (#497).
 *
 * The boot screen and Phase 2 each carried a byte-identical copy of this
 * layout until #508; they now call this instead.
 */
export default function ScreenLoading() {
  return (
    <SafeAreaView className="bg-background flex-1">
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color={COLORS.brand} />
      </View>
    </SafeAreaView>
  );
}
