import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { COLORS } from "~/lib/colors";

export const PULSE_DURATION_MS = 2000;

/**
 * One expanding ring of the radar pulse.
 *
 * Reanimated rather than Tailwind's `animate-ping`: NativeWind does not
 * generate keyframe animations for React Native, so the web class would have
 * compiled to nothing and the screen would have sat perfectly still.
 *
 * Web staggers its second ring with a 1s delay against a 1s animation, which
 * lands it exactly back in phase — the two rings there are drawn on top of each
 * other. This uses half the period as the delay, which is what that was
 * reaching for.
 */
function PulseRing({ delayMs }: { delayMs: number }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withTiming(1, { duration: PULSE_DURATION_MS, easing: Easing.out(Easing.ease) }),
        -1,
        false
      )
    );
  }, [delayMs, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + progress.value * 1.4 }],
    opacity: 0.7 * (1 - progress.value),
  }));

  return (
    <Animated.View
      // Styled inline rather than with a className: NativeWind's class handling
      // does not extend to Reanimated's Animated.View, and a silently unstyled
      // ring is an invisible one.
      style={[
        {
          position: "absolute",
          height: 40,
          width: 40,
          borderRadius: 20,
          backgroundColor: COLORS.brand,
        },
        animatedStyle,
      ]}
    />
  );
}

/**
 * The radar pulse: two expanding rings around a solid brand dot.
 *
 * Shared by the two screens whose whole job is waiting on something the user
 * cannot hurry — the waiting screen looking for a match (#439) and the pitch's
 * pending state, held after "yeah" until the other side answers (#464). Web
 * draws the same motif on both, in the same size, and the mobile version was
 * about to be copied into the second screen rather than shared.
 */
export default function RadarPulse() {
  return (
    <View className="h-24 w-24 items-center justify-center">
      <PulseRing delayMs={0} />
      <PulseRing delayMs={PULSE_DURATION_MS / 2} />
      <View className="bg-brand h-3.5 w-3.5 rounded-full" />
    </View>
  );
}
