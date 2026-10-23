import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { BarneyModeSchema, UserStateResponseSchema } from "@wingman/shared";
import BarneyChat from "~/components/BarneyChat";
import ScreenFailure from "~/components/ScreenFailure";
import ScreenLoading from "~/components/ScreenLoading";
import { Text } from "~/components/ui/text";
import { useBarneyChat } from "~/hooks/useBarneyChat";
import { apiRequest, ApiError } from "~/lib/api";
import { ROUTES, routeForState } from "~/lib/routeForState";
import { clearUser, loadUser } from "~/lib/session";

// How long the completion bubble stays on screen before the hand-off back to
// the pool — same beat phase1 uses.
const HANDOFF_DELAY_MS = 1500;

/**
 * The debrief chat (#467/#468, slice 5) — where the DEBRIEF_NUDGE lands after
 * a Blind Date passes. Barney asks how it went; the conversation ends when his
 * saveFeedback tool fires, which persists the FeedbackRound and returns the
 * user to the matching pool (markDebriefed flips them back to WAITING
 * server-side), so the screen hands off to /waiting.
 *
 * Guarded by hand rather than by useGuardedRoute, exactly like phase2 and for
 * the same reason: entry depends on something routeForState cannot express —
 * followUpState must be DATE_PASSED (the server's statement that the date
 * happened and this user hasn't debriefed yet), and the session needs the
 * matchId the debrief is about. Anyone else is sent to wherever routeForState
 * says they belong, so a stale nudge tap can never open a debrief the api
 * would refuse. Mirrors web's Debrief.tsx gate.
 */
export default function Debrief() {
  const router = useRouter();
  const [guard, setGuard] = useState<{ userId: string; matchId: string } | null>(null);
  const [guardFailed, setGuardFailed] = useState(false);
  // Bumping this re-runs the guard effect — the retry affordance.
  const [attempt, setAttempt] = useState(0);
  const handoffRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const user = await loadUser();
      if (cancelled) return;
      if (!user) {
        router.replace(ROUTES.login);
        return;
      }

      try {
        const state = await apiRequest(`/api/users/${user.id}/state`, {
          schema: UserStateResponseSchema,
        });
        if (cancelled) return;
        // DATE_PASSED is the whole gate: AWAITING_DATE means the date hasn't
        // happened yet, DEBRIEFED means this conversation already ran (and the
        // user is WAITING again), and no followUpState means no date at all —
        // in every case routeForState knows where they belong instead.
        if (state.followUpState !== "DATE_PASSED" || !state.matchId) {
          router.replace(routeForState(state));
          return;
        }
        setGuard({ userId: user.id, matchId: state.matchId });
      } catch (err) {
        // Same reasoning as phase2's guard: only a 404 means the stored session
        // points at a user the api no longer has.
        if (err instanceof ApiError && err.status === 404) {
          await clearUser();
          if (!cancelled) router.replace(ROUTES.login);
          return;
        }
        if (!cancelled) setGuardFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  const handlePhaseComplete = useCallback(() => {
    // markDebriefed has flipped the user back to WAITING server-side — the
    // waiting screen is where they now belong, after a beat to read the bubble.
    handoffRef.current = setTimeout(() => router.replace(ROUTES.waiting), HANDOFF_DELAY_MS);
  }, [router]);

  // Clear the pending hand-off if the screen goes away first, so navigation can
  // never fire against an unmounted screen.
  useEffect(
    () => () => {
      if (handoffRef.current !== null) clearTimeout(handoffRef.current);
    },
    []
  );

  const chat = useBarneyChat({
    userId: guard?.userId ?? null,
    mode: BarneyModeSchema.enum.debrief,
    matchId: guard?.matchId,
    completionMessage: "Thanks, Barney's got your back for next time.",
    onPhaseComplete: handlePhaseComplete,
  });

  if (guardFailed) {
    return (
      <ScreenFailure
        title="Can't reach Wingman"
        body="Your debrief is waiting, but the api didn't answer. Check that this device is online, then try again."
        onRetry={() => {
          setGuardFailed(false);
          setAttempt((n) => n + 1);
        }}
        escape={{ label: "Not now", onPress: () => router.replace(ROUTES.boot) }}
      />
    );
  }

  if (!guard) return <ScreenLoading />;

  if (chat.initFailed) {
    return (
      <ScreenFailure
        title="Couldn't start the debrief"
        body="Barney didn't pick up. Check that this device is online and that the api is reachable, then try again."
        onRetry={chat.retryInit}
        // Not a sign-out: the debrief stays owed, and the boot screen re-derives
        // where this user belongs so they can come back to it from the nudge.
        escape={{ label: "Not now", onPress: () => router.replace(ROUTES.boot) }}
      />
    );
  }

  return (
    // Only the top edge: the composer draws its own bottom inset so it can drop
    // it while the keyboard is up.
    <SafeAreaView className="bg-background flex-1" edges={["top"]}>
      <View className="border-border border-b px-8 pb-4 pt-2">
        <Text
          testID="debrief-heading"
          className="text-foreground text-[22px] font-bold tracking-[-0.66px]"
        >
          How did your date go?
        </Text>
        <Text className="text-muted-foreground mt-0.5 text-sm">Tell Barney everything.</Text>
      </View>
      <BarneyChat
        messages={chat.messages}
        onSend={chat.send}
        loading={chat.loading}
        busy={chat.busy}
        disabled={chat.done || chat.initFailed}
      />
    </SafeAreaView>
  );
}
