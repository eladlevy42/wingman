import { useCallback, useEffect, useRef } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { BarneyModeSchema, type InterviewLanguage } from "@wingman/shared";
import BarneyChat from "~/components/BarneyChat";
import ScreenFailure from "~/components/ScreenFailure";
import ScreenLoading from "~/components/ScreenLoading";
import { useBarneyChat } from "~/hooks/useBarneyChat";
import { useAddressForm } from "~/hooks/useAddressForm";
import { useInterviewLanguage } from "~/hooks/useInterviewLanguage";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { ROUTES } from "~/lib/routeForState";
import { clearUser } from "~/lib/session";

// How long the "that's everything" system bubble stays on screen before the
// hand-off. Long enough to read, short enough not to feel stuck.
const HANDOFF_DELAY_MS = 1500;

/**
 * Phase 1 — the "grill me" interview. The conversation itself lives in
 * useBarneyChat and the surface in BarneyChat; this screen only supplies the
 * user, the mode, and what happens when the profile is saved.
 */
export default function BarneyPhase1() {
  const router = useRouter();
  // Checking that *a* user was stored was not enough: someone who had already
  // finished Phase 1 was handed a fresh interview from question one, and
  // completing it overwrote their existing structuredData through saveProfile's
  // upsert — no confirmation, no way back. routeForState sends a user with a
  // COMPLETED profile to /pending, so asking it is what closes that (#497).
  const { userId, ready } = useGuardedRoute(ROUTES.phase1);
  const handoffRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePhaseComplete = useCallback(() => {
    handoffRef.current = setTimeout(() => router.replace(ROUTES.phase2), HANDOFF_DELAY_MS);
  }, [router]);

  // Clear the pending hand-off if the screen goes away first, so navigation can
  // never fire against an unmounted screen.
  useEffect(
    () => () => {
      if (handoffRef.current !== null) clearTimeout(handoffRef.current);
    },
    []
  );

  const { language, setLanguage, ready: languageReady } = useInterviewLanguage();
  const address = useAddressForm();

  const chat = useBarneyChat({
    // Held at null until the saved language has been read, so the session is
    // never opened in the wrong language and then switched (ADR-0037).
    userId: languageReady ? userId : null,
    language,
    mode: BarneyModeSchema.enum.interview_self,
    completionMessage: "That's everything — saving your profile. Moving to Phase 2…",
    onPhaseComplete: handlePhaseComplete,
  });

  // Saves the choice, then has Barney restate the question already on screen in
  // the new language rather than leaving it until the next reply (ADR-0037).
  const { changeLanguage } = chat;
  const handleLanguageChange = useCallback(
    (next: InterviewLanguage) => {
      setLanguage(next);
      void changeLanguage(next);
    },
    [setLanguage, changeLanguage]
  );

  if (!ready || !languageReady) return <ScreenLoading />;

  // A session that never started is not a conversation with a problem in it —
  // it is no conversation at all. There is no sessionId, so every control the
  // chat surface renders is dead: no send, no Back (the header only appears
  // once `progress` is set, which never happens), and on a device no address
  // bar to reload from. Showing the chat here would be showing an interface
  // whose every affordance is inert, so the screen steps aside for one that can
  // actually get the user somewhere (#494).
  if (chat.initFailed) {
    return (
      <ScreenFailure
        title="Couldn't start the interview"
        body="Barney didn't pick up. Check that this device is online and that the api is reachable, then try again."
        onRetry={chat.retryInit}
        // Sign-out, not "sign in instead": unlike the boot screen, we know who
        // this user is and they have a live session — the way out is to end it.
        escape={{
          label: "Sign out",
          onPress: () => {
            // `.then` without a `.catch` would strand the user on this dead-end
            // screen if clearUser() ever rejected, with nothing on screen saying
            // why. It swallows its own storage errors today, so this is
            // defensive — but the navigation must happen either way, or sign-out
            // silently does nothing.
            void clearUser()
              .catch(() => undefined)
              .then(() => router.replace(ROUTES.login));
          },
        }}
      />
    );
  }

  return (
    // Only the top edge: the composer draws its own bottom inset so it can drop
    // it while the keyboard is up.
    <SafeAreaView className="bg-background flex-1" edges={["top"]}>
      <BarneyChat
        messages={chat.messages}
        onSend={chat.send}
        loading={chat.loading}
        busy={chat.busy}
        disabled={chat.done || chat.initFailed}
        section={chat.section}
        progress={chat.progress}
        input={chat.input}
        onBack={chat.goBack}
        language={language}
        onLanguageChange={handleLanguageChange}
        address={address}
      />
    </SafeAreaView>
  );
}
