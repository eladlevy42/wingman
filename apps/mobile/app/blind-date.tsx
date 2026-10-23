import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { BlindDateResponse } from "@wingman/shared";
import HeartPhotos from "~/components/blindDate/HeartPhotos";
import ScreenLoading from "~/components/ScreenLoading";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { isServerAuthoredError } from "~/lib/api";
import { loadBlindDate, partnerSubline, personalityBlurb } from "~/lib/blindDate";
import { formatDateTime } from "~/lib/schedule";
import { ROUTES } from "~/lib/routeForState";

const LOAD_ERROR_MESSAGE = "Could not load your date. Please try again.";

/**
 * The confirmed date (#465) — "It's a date.", the venue, the time, and the
 * person, once the chooser has locked in a slot.
 *
 * Fire-and-forget per docs/adr/0012: there is no cancel and no reschedule, so
 * this screen only reads. It is also terminal for now — nothing moves a user
 * off it, which is why it has no poll where the pitch and choose-times both do.
 * That changes with the debrief (#441), which is what the date passing will
 * eventually lead to.
 *
 * Web offers an "Add to calendar" export here, which mobile does not. Doing it
 * natively means expo-calendar, a permission prompt and a new native module —
 * and a new native module means rebuilding the development client every device
 * run. Tracked separately rather than smuggled into this slice.
 */
export default function BlindDate() {
  const { userId, ready } = useGuardedRoute(ROUTES.blindDate);
  const [blindDate, setBlindDate] = useState<BlindDateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again", which is what re-runs the load effect.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    void (async () => {
      try {
        const loaded = await loadBlindDate(userId);
        if (!cancelled) setBlindDate(loaded);
      } catch (err) {
        // Prefer the server's own words where it authored them.
        if (!cancelled) setError(isServerAuthoredError(err) ? err.message : LOAD_ERROR_MESSAGE);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  if (!ready) return <ScreenLoading />;

  if (error !== null) {
    return (
      <SafeAreaView className="bg-background flex-1">
        <View className="flex-1 justify-center gap-4 px-8">
          <Text className="text-foreground text-[22px] font-semibold">
            Can&apos;t load your date
          </Text>
          <Text className="text-muted-foreground text-base leading-6">{error}</Text>
          <Button className="mt-2 h-14 w-full rounded-[18px]" onPress={retry}>
            <Text className="text-base font-semibold">Try again</Text>
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  if (blindDate === null) return <ScreenLoading />;

  const firstName = blindDate.partnerName.split(" ")[0] ?? "";
  const subline = partnerSubline(blindDate.partnerProfile);
  const blurb = personalityBlurb(blindDate.partnerProfile);

  return (
    <SafeAreaView className="bg-background flex-1">
      <View className="flex-1 px-8 pt-8">
        <View className="flex-row items-center gap-2">
          <View className="bg-brand h-[7px] w-[7px] rounded-full" />
          <Text className="text-muted-foreground text-xs uppercase tracking-[1.2px]">
            Confirmed
          </Text>
        </View>
        <Text className="text-foreground mb-[22px] mt-3.5 text-[32px] font-bold tracking-[-0.96px]">
          It&apos;s a date.
        </Text>

        <View className="border-border items-center gap-[18px] rounded-3xl border px-6 py-[26px]">
          <Text className="text-muted-foreground/60 text-[11px] uppercase tracking-[2.4px]">
            Wingman
          </Text>

          <View className="items-center gap-2">
            <HeartPhotos selfUrl={blindDate.selfPhotoUrl} partnerUrl={blindDate.partnerPhotoUrl} />
            <Text className="text-muted-foreground/60 text-[10px] uppercase tracking-[1.2px]">
              You + {firstName}
            </Text>
          </View>

          <View className="bg-border h-px w-full" />

          <View className="items-center gap-1">
            <Text className="text-foreground text-2xl font-bold tracking-[-0.48px]">
              {blindDate.partnerName}
            </Text>
            {subline !== "" && <Text className="text-muted-foreground text-sm">{subline}</Text>}
          </View>

          <View className="items-center gap-0.5">
            <Text className="text-foreground text-base font-semibold">{blindDate.venue}</Text>
            <Text className="text-brand text-sm font-medium" testID="blind-date-time">
              {formatDateTime(blindDate.dateTime)}
            </Text>
          </View>

          {blurb !== null && (
            <Text className="text-muted-foreground text-center text-[13.5px] leading-5">
              {blurb}
            </Text>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
