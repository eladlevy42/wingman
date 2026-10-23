import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  OrchestrationStatusResponseSchema,
  TriggerMatchStartResponseSchema,
  UserStateResponseSchema,
} from "@wingman/shared";
import AppNav from "~/components/AppNav";
import RadarPulse from "~/components/RadarPulse";
import ScreenLoading from "~/components/ScreenLoading";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { apiRequest } from "~/lib/api";
import { ROUTES, routeForMatchingState } from "~/lib/routeForState";

// Mirrors the backend's MATCH_COOLDOWN_MINUTES default, exactly as web's
// Waiting.tsx does — there is still no shared config channel between apps/api
// and the clients, so this duplicates the value. Keep all three in sync.
const MATCH_COOLDOWN_MINUTES = 1;
const MS_PER_MINUTE = 60_000;
const POLL_INTERVAL_MS = Math.max(5000, MATCH_COOLDOWN_MINUTES * MS_PER_MINUTE);

// Faster cadence while a manually-triggered cycle is in flight — the user is
// actively watching. The slow interval resumes once it settles.
const ACTIVE_POLL_INTERVAL_MS = 4000;

/**
 * The Waiting screen (#439): where a user sits between finishing onboarding and
 * Barney finding them someone.
 *
 * Two ways out, and both matter. The poll below is the reliable one — it reads
 * the server's own matchingState, so it is right even if every notification was
 * missed. The MATCH_FOUND banner is the fast one, and it is what the user
 * actually sees. Neither is a substitute for the other.
 */
export default function Waiting() {
  const router = useRouter();
  const { userId, ready } = useGuardedRoute(ROUTES.waiting);

  // "idle" -> button available; "searching" -> a cycle is running (ours, or an
  // in-flight one we joined); "exhausted" -> a cycle finished with no match.
  const [searchPhase, setSearchPhase] = useState<"idle" | "searching" | "exhausted">("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Returns true once it has navigated away, so the caller can stop polling.
  const leaveIfMovedOn = useCallback(
    async (id: string): Promise<boolean> => {
      const state = await apiRequest(`/api/users/${id}/state`, {
        schema: UserStateResponseSchema,
      });
      // Asks the same function the router asks rather than listing the states
      // by hand, so slice 4 pointing MATCHED at the pitch screen moves this
      // screen's exit with it — one place, not two.
      const destination = routeForMatchingState(state.matchingState);
      if (destination === ROUTES.waiting) return false;
      router.replace(destination);
      return true;
    },
    [router]
  );

  // The steady-state watch: poll until the user's matching state moves on.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function poll() {
      try {
        if (!cancelled) await leaveIfMovedOn(userId!);
      } catch {
        // Transient network errors retry on the next tick. A phone that has
        // walked out of range should not be shown an error on a screen whose
        // whole job is to wait.
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId, leaveIfMovedOn]);

  // While a triggered cycle runs, watch it closely: the state (to leave the
  // moment a match lands) and the orchestration status (to know when the cycle
  // finished). A finished cycle with the user still WAITING is the honest
  // "nobody available right now" outcome — not an error.
  useEffect(() => {
    if (searchPhase !== "searching" || !userId) return;
    let cancelled = false;

    async function watch() {
      try {
        if (cancelled || (await leaveIfMovedOn(userId!))) return;
        const status = await apiRequest("/api/match/orchestration-status", {
          schema: OrchestrationStatusResponseSchema,
        });
        if (!cancelled && !status.running) setSearchPhase("exhausted");
      } catch {
        // Retries on the next tick.
      }
    }

    void watch();
    const interval = setInterval(() => void watch(), ACTIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [searchPhase, userId, leaveIfMovedOn]);

  // Manual trigger, dev-only surface. The cycle runs in the background: this
  // only starts it (or joins one already in flight) and flips the screen into
  // its watching state. Real negotiations take minutes.
  async function handleTriggerMatch() {
    if (!userId || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await apiRequest(`/api/users/${userId}/trigger-match`, {
        method: "POST",
        schema: TriggerMatchStartResponseSchema,
        fallbackErrorMessage: "Could not start the search — please try again.",
      });
      // `started: false` only means a cycle is already in flight — join it.
      setSearchPhase("searching");
    } catch {
      setError("Could not start the search — please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!ready) return <ScreenLoading />;

  return (
    <SafeAreaView className="bg-background flex-1">
      <AppNav />
      <View className="flex-1 items-center justify-center px-8 py-16">
        <RadarPulse />

        <View className="mt-9 items-center gap-3">
          <Text className="text-foreground text-center text-[30px] font-bold leading-9 tracking-[-0.9px]">
            Finding{"\n"}your match.
          </Text>
          <Text className="text-muted-foreground max-w-[270px] text-center text-[15px] leading-6">
            Wingman is reviewing the community to introduce you thoughtfully. You&apos;ll be
            notified when there&apos;s a match worth your time.
          </Text>
        </View>

        <View className="mt-9 flex-row items-center gap-2">
          <View className="bg-brand h-[7px] w-[7px] rounded-full" />
          <Text className="text-muted-foreground text-xs uppercase tracking-[1.2px]">
            Searching
          </Text>
        </View>

        {__DEV__ && (
          <View className="mt-10 items-center">
            <Text className="text-muted-foreground/60 mb-2 text-xs">Dev only</Text>
            {searchPhase === "searching" ? (
              <Text testID="search-progress" className="text-brand text-sm font-medium">
                Barney is negotiating for you — this can take a few minutes…
              </Text>
            ) : (
              <Button variant="ghost" onPress={handleTriggerMatch} disabled={isSubmitting}>
                <Text>{searchPhase === "exhausted" ? "Search again" : "Trigger match now"}</Text>
              </Button>
            )}
            {searchPhase === "exhausted" && (
              <Text
                testID="search-exhausted"
                className="text-muted-foreground mt-3 text-center text-sm"
              >
                Barney couldn&apos;t pair you this round — there&apos;s no one else waiting right
                now. A manual search always ends in a match when anyone is available.
              </Text>
            )}
            {error && <Text className="text-muted-foreground mt-3 text-sm">{error}</Text>}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}
