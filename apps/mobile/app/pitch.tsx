import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { UserStateResponseSchema } from "@wingman/shared";
import AppNav from "~/components/AppNav";
import BarneyChat from "~/components/BarneyChat";
import PendingState from "~/components/PendingState";
import DecisionScreen from "~/components/pitch/DecisionScreen";
import IntroCard from "~/components/pitch/IntroCard";
import ScreenFailure from "~/components/ScreenFailure";
import ScreenLoading from "~/components/ScreenLoading";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { useBarneyChat } from "~/hooks/useBarneyChat";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { usePitchSession } from "~/hooks/usePitchSession";
import { apiRequest, isServerAuthoredError } from "~/lib/api";
import { submitDecision, type Decision } from "~/lib/decision";
import {
  afterTurn,
  canAsk,
  loadPitchCounter,
  questionsLeft,
  savePitchCounter,
  TOTAL_QUESTIONS,
} from "~/lib/pitchCounter";
import { ROUTES, routeForMatchingState } from "~/lib/routeForState";

// Which of the pitch's three screens is showing. One route rather than three,
// matching web: the reveal, the chat and the decision share a single loaded
// match and a single Barney session, and splitting them across routes would
// mean re-fetching both or threading them through navigation params.
type Phase = "intro" | "chat" | "decision";

const DECIDE_ERROR_MESSAGE = "Could not record your decision. Please try again.";

// How often to re-read state while holding after "yeah". Web's interval, and
// deliberately much faster than the waiting screen's minute: the user is
// staring at this screen waiting for one specific person to answer, and the
// match cannot move on without them.
const DECISION_POLL_INTERVAL_MS = 2500;

/**
 * The pitch screen — where a MATCHED user lands, from a cold start, from the
 * waiting screen's poll, or from a MATCH_FOUND banner/push tap.
 *
 * Three screens in one route: the Match Reveal card (#462), the Genie Mechanic
 * chat (#463), and the Yeah/Nah decision (#464) that both "Maybe later" and a
 * spent allowance lead to.
 *
 * This is the first guarded screen a user leaves without navigating themselves.
 * Saying yeah does nothing visible until the other side answers, and it is the
 * *server* that moves them on when it does — so the mount-time guard that let
 * them in cannot be what takes them out, and the poll below is not a
 * convenience. See useGuardedRoute's note on screens that stay mounted across a
 * state change.
 */
export default function Pitch() {
  const router = useRouter();
  // `state` is the guard's own `/state` read, handed back rather than refetched:
  // matchId is the one field the pitch needs from it and there is still no other
  // channel that delivers it to a client (#53).
  const { userId, ready, state } = useGuardedRoute(ROUTES.pitch);
  const { partnerName, education, matchPhotoUrl, loaded } = usePitchSession(userId);
  const matchId = state?.matchId ?? null;
  const [phase, setPhase] = useState<Phase>("intro");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // Synchronous companion to `decisionPending`, for the same reason
  // useBarneyChat keeps one beside `busy`: two taps landing in the same React
  // batch both read the pre-update state, so the state flag alone cannot
  // serialize them. The ref flips before either handler can await anything.
  // Double-submitting is worse here than on a turn — it is a decision.
  const decidingRef = useRef(false);

  // How many questions have landed. The allowance is derived from it rather
  // than stored as its own countdown, so there is one number to get wrong.
  const [asked, setAsked] = useState(0);
  // The conversation whose stored count has been read back — compared against
  // the live session id rather than kept as a boolean, so replacing the
  // conversation un-hydrates the screen by that comparison alone. A boolean
  // would need clearing from the effect body, which is a synchronous setState
  // in an effect and a cascading render.
  const [countedFor, setCountedFor] = useState<string | null>(null);

  const chat = useBarneyChat({
    userId,
    mode: "pitch",
    // The session only opens once the matchId is known; until then useBarneyChat
    // sits idle rather than opening a pitch session against no match.
    matchId: matchId ?? undefined,
  });

  // Keyed to the conversation, not the match or the user, so the count lasts
  // exactly as long as the transcript it belongs to: a resumed pitch keeps its
  // session id and its spent questions, while a session the api has dropped is
  // replaced by a new id that carries no count — an empty chat and a full
  // allowance, which is the right pairing.
  const sessionId = chat.sessionId;
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      const stored = await loadPitchCounter(sessionId);
      if (cancelled) return;
      setAsked(stored);
      setCountedFor(sessionId);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // The composer stays shut until this is true: useBarneyChat resumes a pitch
  // with its transcript intact, so opening on the initial 0 would show three
  // questions left above a chat that had already used them.
  const hydrated = sessionId !== null && countedFor === sessionId;

  const left = questionsLeft(asked);

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      // Checked here as well as in the composer's `disabled`: disabling is the
      // affordance, this is the enforcement. Barney is never told to stop
      // (ADR-0013), so a send that slips past the disabled state — an in-flight
      // tap, a future caller — must still be refused.
      // `hydrated` belongs in the same guard as the allowance: before the
      // stored count is back, `asked` is 0 for a conversation that may already
      // have spent all three, so sending on it would be the reload bypass this
      // is here to close.
      if (!hydrated || !canAsk(asked, chat.busy)) return false;

      const succeeded = await chat.send(text);
      // Read from the closure rather than through a setState updater: the busy
      // gate above serializes turns, so `asked` cannot be stale here, and the
      // write stays outside React's updater where a StrictMode double-invoke
      // would run it twice.
      const next = afterTurn(asked, succeeded);
      setAsked(next);
      if (sessionId) await savePitchCounter(sessionId, next);
      return succeeded;
    },
    [asked, chat, hydrated, sessionId]
  );

  const handleDecide = useCallback(
    (choice: Decision) => {
      if (!userId || decidingRef.current || decisionPending) return;
      decidingRef.current = true;
      setDecisionPending(true);
      setDecisionError(null);

      void (async () => {
        try {
          await submitDecision(matchId ?? undefined, userId, choice);
          setDecision(choice);
          // A nah ends this match outright — the api rejects it and puts the
          // user back in the pool, so there is nothing to wait for. `replace`
          // rather than `push`: the pitch they just declined must not be one
          // back gesture away.
          if (choice === "nah") router.replace(ROUTES.waiting);
        } catch (err) {
          // Prefer the server's own words. "Match not found" tells someone what
          // happened; the generic line costs them a debugging session.
          setDecisionError(isServerAuthoredError(err) ? err.message : DECIDE_ERROR_MESSAGE);
        } finally {
          decidingRef.current = false;
          setDecisionPending(false);
        }
      })();
    },
    [userId, matchId, decisionPending, router]
  );

  // The wait after "yeah". Follows the server rather than guessing: both-yeah
  // opens choose-times, and the other side saying nah puts this user back in
  // the pool — neither of which this client is told any other way.
  useEffect(() => {
    if (decision !== "yeah" || !userId) return;
    let cancelled = false;

    async function poll() {
      try {
        const current = await apiRequest(`/api/users/${userId}/state`, {
          schema: UserStateResponseSchema,
        });
        if (cancelled) return;
        const destination = routeForMatchingState(current.matchingState);
        if (destination !== ROUTES.pitch) router.replace(destination);
      } catch {
        // Transient errors retry on the next tick.
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), DECISION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [decision, userId, router]);

  if (!ready || !loaded) return <ScreenLoading />;

  // Outranks `phase`: once yeah is recorded there is nothing to go back to, and
  // the poll above is what moves the user on.
  if (decision === "yeah") {
    return (
      <SafeAreaView className="bg-background flex-1">
        <AppNav />
        <PendingState
          title="You said yeah."
          body="We'll let you know the moment your match says yeah too — then you'll pick a time together."
        />
      </SafeAreaView>
    );
  }

  if (phase === "intro") {
    return (
      <SafeAreaView className="bg-background flex-1">
        <AppNav />
        <IntroCard
          partnerName={partnerName}
          education={education}
          totalQuestions={TOTAL_QUESTIONS}
          onSendWish={() => setPhase("chat")}
          // Skipping the questions is allowed — the mechanic caps what a user
          // may ask, it does not oblige them to ask anything.
          onMaybeLater={() => setPhase("decision")}
        />
      </SafeAreaView>
    );
  }

  if (phase === "decision") {
    return (
      <SafeAreaView className="bg-background flex-1">
        <AppNav />
        <DecisionScreen
          matchPhotoUrl={matchPhotoUrl}
          partnerName={partnerName}
          education={education}
          decisionError={decisionError}
          decisionPending={decisionPending}
          onDecide={handleDecide}
        />
      </SafeAreaView>
    );
  }

  // The pitch session could not be opened. Same reasoning as phase1: rendering
  // the chat here would be rendering an interface whose every affordance is
  // inert (#494). The escape is the reveal card rather than a sign-out — this
  // user has a live match, and the card is still a place they can act from.
  if (chat.initFailed) {
    return (
      <ScreenFailure
        title="Couldn't start the pitch"
        body="Barney didn't pick up. Check that this device is online and that the api is reachable, then try again."
        onRetry={chat.retryInit}
        escape={{ label: "Back to the reveal", onPress: () => setPhase("intro") }}
      />
    );
  }

  return (
    <SafeAreaView className="bg-background flex-1">
      <AppNav />
      <View className="border-border border-b px-8 py-3">
        <View className="flex-row items-center gap-2">
          <View className="bg-brand h-[7px] w-[7px] rounded-full" />
          <Text
            testID="questions-left"
            className="text-muted-foreground text-xs uppercase tracking-[1.2px]"
          >
            {left === 0
              ? "No questions left"
              : `${left} ${left === 1 ? "question" : "questions"} left`}
          </Text>
        </View>

        {/* The way out of a spent chat. The composer below stays visible but
            shut, so without this the screen would be a room with no door — the
            user has met the mechanic's limit and the decision is the only thing
            left to do. Rendered here rather than under the transcript because
            the composer owns the bottom of the screen. */}
        {left === 0 && (
          <Button
            testID="see-who-it-is"
            className="mt-3 w-full"
            onPress={() => setPhase("decision")}
          >
            <Text>See who it is</Text>
          </Button>
        )}
      </View>
      <BarneyChat
        messages={chat.messages}
        onSend={handleSend}
        loading={chat.loading}
        busy={chat.busy}
        // The composer closes for good once the allowance is spent — this is the
        // "a 4th question is impossible via the UI" acceptance criterion. Shut
        // during hydration too, so the bypass is not simply narrowed to the
        // window before the stored count lands.
        disabled={left === 0 || !hydrated}
      />
    </SafeAreaView>
  );
}
