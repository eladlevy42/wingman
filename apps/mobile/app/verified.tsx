import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import ScreenLoading from "~/components/ScreenLoading";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { COLORS } from "~/lib/colors";
import { ROUTES } from "~/lib/routeForState";

// Success confirmation shown right after the university-verification step —
// Continue drops the user straight into the Phase 1 interview chat. Ported from
// apps/web/src/pages/Verified.tsx.
export default function Verified() {
  const router = useRouter();
  // Guarded on phase1 rather than a route of its own: this is the interstitial
  // in front of the interview, so it belongs to exactly the people the api says
  // should be starting one. Without it the screen rendered in full to a visitor
  // with no session at all (#497).
  const { ready } = useGuardedRoute(ROUTES.phase1);

  if (!ready) return <ScreenLoading />;

  return (
    <SafeAreaView className="bg-background flex-1">
      <View className="w-full max-w-sm flex-1 self-center px-8">
        <View className="flex-1 items-center justify-center gap-7">
          <View className="border-brand h-[92px] w-[92px] items-center justify-center rounded-full border-[1.5px]">
            <Check size={44} color={COLORS.brand} strokeWidth={1.6} />
          </View>
          <View className="items-center gap-2.5">
            <Text className="text-foreground text-[32px] font-bold tracking-[-0.96px]">
              You&apos;re Verified
            </Text>
            <Text className="text-muted-foreground text-base">Welcome to Wingman.</Text>
          </View>
        </View>
        <View className="pb-12">
          <Button
            className="h-14 w-full rounded-[18px]"
            onPress={() => router.replace(ROUTES.phase1)}
            testID="verified-continue"
          >
            <Text className="text-base font-semibold">Continue</Text>
          </Button>
        </View>
      </View>
    </SafeAreaView>
  );
}
