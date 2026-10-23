import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";

const FADE_IN_DURATION_MS = 200;

interface IntroCardProps {
  partnerName: string | null;
  education: string | null;
  totalQuestions: number;
  onSendWish: () => void;
  onMaybeLater: () => void;
}

/**
 * The "Introducing…" reveal card (ADR-0022) — the pitch's opening screen. It
 * names the match and shows their education, then leads either into the
 * 3-question genie chat ("Send a wish", #463) or straight to the decision
 * ("Maybe later", #464).
 *
 * Mobile counterpart of apps/web/src/components/pitch/IntroCard.tsx, and
 * deliberately the same card: same eyebrow, same hierarchy, same copy.
 *
 * Renders name and education only. The photo is fetched alongside them but held
 * back for the decision screen — that is ADR-0022's shape, not an omission.
 *
 * Every field is nullable, so both have a fallback rather than a guard that
 * hides the card: a matched user with an incomplete profile still gets a
 * working screen, which is the whole reason getMatchPhoto answers nulls instead
 * of erroring.
 */
export default function IntroCard({
  partnerName,
  education,
  totalQuestions,
  onSendWish,
  onMaybeLater,
}: IntroCardProps) {
  // NativeWind does not compile `animate-in fade-in` for React Native, so the
  // entrance is a Reanimated opacity — same 200ms ease-out the design system
  // asks for, expressed the way waiting.tsx already had to express its pulse.
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(1, {
      duration: FADE_IN_DURATION_MS,
      easing: Easing.out(Easing.ease),
    });
  }, [opacity]);
  const fadeIn = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // Two fallbacks, not one: the heading starts a sentence and the placeholder
  // sits mid-sentence ("Ask your match anything"). Sharing a single capitalised
  // fallback put "Ask Your match anything" on screen. Web splits them the same
  // way.
  const headingName = partnerName ?? "Your match";
  const inlineName = partnerName ?? "your match";

  return (
    <Animated.View style={[{ flex: 1 }, fadeIn]}>
      <View className="mx-auto w-full max-w-sm flex-1">
        <View className="flex-1 px-8 pt-8">
          <View className="flex-row items-center gap-2">
            <View className="bg-brand h-[7px] w-[7px] rounded-full" />
            <Text className="text-muted-foreground text-xs uppercase tracking-[1.2px]">
              Introducing
            </Text>
          </View>

          <Text
            testID="intro-partner-name"
            className="text-foreground mt-4 text-[32px] font-bold tracking-[-0.96px]"
          >
            {headingName}
          </Text>
          {education && (
            <Text testID="intro-education" className="text-muted-foreground mt-1 text-[15px]">
              {education}
            </Text>
          )}

          <Text className="text-foreground mt-[22px] text-[15.5px] leading-6">
            Barney picked them just for you. Ask up to {totalQuestions} questions before you decide
            — or trust your gut.
          </Text>

          <View className="mt-8 flex-row items-center gap-2">
            <Text className="text-muted-foreground text-xs uppercase tracking-[1.2px]">
              Your Genie Wish
            </Text>
          </View>
          {/* Inert on purpose: a preview of the chat #463 opens, not an input.
              It is what makes "Send a wish" read as the obvious next tap. */}
          <View className="border-border mt-4 w-full flex-row items-center rounded-lg border px-[18px] py-[18px]">
            <View className="bg-brand mr-2 h-5 w-0.5" />
            <Text className="text-muted-foreground/50 text-[15px]">Ask {inlineName} anything…</Text>
          </View>
        </View>

        <View className="gap-3 px-8 pb-12 pt-6">
          <Button testID="send-a-wish" onPress={onSendWish} className="h-14 w-full">
            <Text className="text-base font-semibold">Send a wish</Text>
          </Button>
          <Button testID="maybe-later" variant="ghost" onPress={onMaybeLater} className="w-full">
            <Text className="text-muted-foreground text-[15px] font-medium">Maybe later</Text>
          </Button>
        </View>
      </View>
    </Animated.View>
  );
}
