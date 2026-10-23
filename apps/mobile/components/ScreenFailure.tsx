import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";

/**
 * A full-screen "this didn't work, here is the way out" state (#508).
 *
 * Three screens hand-rolled this separately — the boot screen, Phase 2's guard,
 * and Phase 1's InterviewStartFailed — and had already drifted apart in heading
 * size, container width, and whether the escape hatch was a ghost button stacked
 * under the primary or an outline one pinned to the bottom.
 *
 * What is genuinely per-screen is the title, the body, and the escape: "Can't
 * reach Wingman → Sign in instead" and "Couldn't start the interview → Sign out"
 * are different situations with different ways out, so those stay props. Every
 * other difference was accidental and is resolved here.
 *
 * The escape is pinned to the bottom rather than stacked under the retry so the
 * two read as what they are — the action, and the way out — instead of as two
 * competing suggestions.
 */
export default function ScreenFailure({
  title,
  body,
  onRetry,
  retryLabel = "Try again",
  escape,
}: {
  title: string;
  body: string;
  onRetry: () => void;
  retryLabel?: string;
  escape: { label: string; onPress: () => void };
}) {
  return (
    <SafeAreaView className="bg-background flex-1">
      <View className="w-full max-w-sm flex-1 self-center px-8">
        <View className="flex-1 justify-center gap-4">
          <Text className="text-foreground text-[30px] font-bold tracking-[-0.9px]">{title}</Text>
          <Text className="text-muted-foreground text-base leading-6">{body}</Text>
          <Button className="mt-2 h-14 w-full rounded-[18px]" onPress={onRetry}>
            <Text className="text-base font-semibold">{retryLabel}</Text>
          </Button>
        </View>
        <View className="pb-12">
          <Button variant="outline" className="h-14 w-full rounded-[18px]" onPress={escape.onPress}>
            <Text className="text-base font-semibold">{escape.label}</Text>
          </Button>
        </View>
      </View>
    </SafeAreaView>
  );
}
