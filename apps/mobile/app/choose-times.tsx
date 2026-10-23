import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { UserStateResponseSchema, type UserStateResponse } from "@wingman/shared";
import PendingState from "~/components/PendingState";
import ScreenLoading from "~/components/ScreenLoading";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { apiRequest, isServerAuthoredError } from "~/lib/api";
import { COLORS } from "~/lib/colors";
import { ROUTES, routeForMatchingState } from "~/lib/routeForState";
import {
  formatSlot,
  maxSelectFor,
  offeredSlots,
  submitAvailability,
  toggleSlot,
  type TimeRole,
} from "~/lib/schedule";

const SUBMIT_ERROR_MESSAGE = "Could not save your choice. Please try again.";

// The chooser's screen has to appear the moment the proposer picks, and the
// proposer's has to follow through once the chooser locks in the date — neither
// of which this client is told any other way. Web's interval.
const POLL_INTERVAL_MS = 3000;

interface TimeSelection {
  role: TimeRole | null;
  candidateSlots: string[];
  proposedSlots: string[];
  hasSubmitted: boolean;
}

function selectionFrom(state: UserStateResponse): TimeSelection {
  return {
    role: state.timeRole ?? null,
    candidateSlots: state.candidateSlots ?? [],
    proposedSlots: state.proposedSlots ?? [],
    hasSubmitted: state.hasSubmittedAvailability ?? false,
  };
}

/**
 * Choose-your-times (#465, #248, docs/adr/0012).
 *
 * Both users said yeah, and the api rolled one of them at random as the
 * proposer: they pick up to three of a shared slate, and the chooser picks one
 * of those three, which sets the venue and makes it a date.
 *
 * The two roles see genuinely different screens, and each spends part of its
 * time waiting on the other — so this polls rather than trusting the state the
 * guard handed it. That state is only a snapshot of the moment the screen
 * opened, and on this screen it is normally out of date within seconds.
 */
export default function ChooseTimes() {
  const router = useRouter();
  const { userId, ready, state } = useGuardedRoute(ROUTES.chooseTimes);
  const [polled, setPolled] = useState<TimeSelection | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Set the moment the proposer's submission is accepted, so their screen flips
  // to the waiting state without sitting on a stale list for up to a poll. The
  // next poll confirms it; this only covers the gap.
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // See the note in app/pitch.tsx: `submitting` is state, so two taps in one
  // React batch both read it as false. The chooser's tap writes the venue and
  // flips both users to DATE_ASSIGNED, which is not something to do twice.
  const submittingRef = useRef(false);

  const matchId = state?.matchId;

  // The guard already fetched a state to decide this screen was the right one,
  // so the first frame comes from that rather than a second identical request.
  // Everything after it comes from the poll.
  const selection = polled ?? (state === null ? null : selectionFrom(state));

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function poll() {
      try {
        const current = await apiRequest(`/api/users/${userId}/state`, {
          schema: UserStateResponseSchema,
        });
        if (cancelled) return;
        const destination = routeForMatchingState(current.matchingState);
        if (destination !== ROUTES.chooseTimes) {
          router.replace(destination);
          return;
        }
        setPolled(selectionFrom(current));
      } catch {
        // Transient errors retry on the next tick. The screen keeps showing
        // whatever it last knew, which is better than blanking it.
      }
    }

    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId, router]);

  const maxSelect = maxSelectFor(selection?.role ?? null);

  const handleToggle = useCallback(
    (iso: string) => {
      setSelected((prev) => toggleSlot(prev, iso, maxSelect));
    },
    [maxSelect]
  );

  const handleConfirm = useCallback(() => {
    if (!userId || selected.length === 0 || submittingRef.current || submitting) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    void (async () => {
      try {
        const result = await submitAvailability(matchId, userId, selected);
        // Only the chooser's pick sets a date. Anything else means the proposer
        // has just forwarded their times and is now the one waiting.
        if (result.matchingState === "DATE_ASSIGNED") {
          router.replace(ROUTES.blindDate);
          return;
        }
        setJustSubmitted(true);
        setSelected([]);
      } catch (err) {
        setError(isServerAuthoredError(err) ? err.message : SUBMIT_ERROR_MESSAGE);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    })();
  }, [userId, matchId, selected, submitting, router]);

  if (!ready || selection === null) return <ScreenLoading />;

  const isProposer = selection.role === "proposer";

  if (isProposer && (selection.hasSubmitted || justSubmitted)) {
    return (
      <SafeAreaView className="bg-background flex-1">
        <PendingState
          title="Times sent."
          body="We'll lock in your date the moment your match picks one of your times."
        />
      </SafeAreaView>
    );
  }

  const offered = offeredSlots(selection.role, selection.candidateSlots, selection.proposedSlots);

  if (!isProposer && offered.length === 0) {
    return (
      <SafeAreaView className="bg-background flex-1">
        <PendingState
          title="Almost there."
          body="Waiting for your match to share the times they're free — you'll pick the final one."
        />
      </SafeAreaView>
    );
  }

  const heading = isProposer ? "When are you free?" : "Pick your date.";
  const subheading = isProposer
    ? "Pick up to three times that work for you."
    : "Choose the one that works best — this locks in your date.";
  const cta = isProposer ? "Send my times" : "Confirm date";

  return (
    <SafeAreaView className="bg-background flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-8 pt-9"
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-baseline justify-between">
          <Text className="text-foreground text-[30px] font-bold tracking-[-0.9px]">{heading}</Text>
          <Text className="text-brand text-xs tracking-[0.96px]">
            {selected.length} / {maxSelect}
          </Text>
        </View>
        <Text className="text-muted-foreground mt-3 text-[15px] leading-6">{subheading}</Text>

        <View className="mt-7 gap-2.5">
          {offered.map((iso) => {
            const { day, time } = formatSlot(iso);
            const isSelected = selected.includes(iso);
            return (
              <Pressable
                key={iso}
                onPress={() => handleToggle(iso)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                testID="time-slot"
                className={
                  isSelected
                    ? "border-brand flex-row items-center justify-between rounded-[18px] border-[1.5px] px-[18px] py-[17px]"
                    : "border-border flex-row items-center justify-between rounded-[18px] border px-[18px] py-[17px]"
                }
              >
                <Text
                  className={
                    isSelected
                      ? "text-foreground text-[15px] font-medium"
                      : "text-muted-foreground text-[15px] font-medium"
                  }
                >
                  {day} <Text className="text-muted-foreground font-normal">· {time}</Text>
                </Text>
                {isSelected ? (
                  <View className="bg-brand h-[22px] w-[22px] items-center justify-center rounded-full">
                    <Check size={12} color={COLORS.primaryForeground} strokeWidth={3} />
                  </View>
                ) : (
                  <View className="border-border h-[22px] w-[22px] rounded-full border-[1.5px]" />
                )}
              </Pressable>
            );
          })}
        </View>

        {error !== null && (
          <Text className="text-destructive mt-4 text-sm" testID="choose-times-error">
            {error}
          </Text>
        )}
      </ScrollView>

      <View className="px-8 pb-12 pt-6">
        <Button
          className="h-14 w-full rounded-[18px]"
          disabled={selected.length === 0 || submitting}
          onPress={handleConfirm}
          testID="confirm-times"
        >
          <Text className="text-base font-semibold">{submitting ? "Saving…" : cta}</Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
