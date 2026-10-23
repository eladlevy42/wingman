import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { BarneyModeSchema, UserStateResponseSchema, type InterviewLanguage } from "@wingman/shared";
import BarneyChat from "~/components/BarneyChat";
import PhotoStep from "~/components/PhotoStep";
import ScreenFailure from "~/components/ScreenFailure";
import ScreenLoading from "~/components/ScreenLoading";
import { Text } from "~/components/ui/text";
import { useBarneyChat } from "~/hooks/useBarneyChat";
import { useAddressForm } from "~/hooks/useAddressForm";
import { useInterviewLanguage } from "~/hooks/useInterviewLanguage";
import { ApiError, apiRequest } from "~/lib/api";
import { ROUTES, routeForState } from "~/lib/routeForState";
import { clearUser, loadUser } from "~/lib/session";

// Scripted (non-LLM) follow-up shown once Phase 2 completes — see
// docs/adr/0016-post-interview-photo-request.md for why this is hardcoded copy
// rather than a real model turn, even though it renders as a Barney bubble like
// every other assistant message. Verbatim from the web client so the two
// clients ask for the photo in the same words.
const PHOTO_REQUEST_MESSAGE =
  "One more thing before I go match-making — can you upload a current photo? I want your match to really see who they're meeting.";

// How long "Moving to matching…" stays on screen before the hand-off. Same beat
// Phase 1 uses between its completion notice and the next screen.
const HANDOFF_DELAY_MS = 1500;

/**
 * Phase 2 — "what are you looking for", followed by the match photo.
 *
 * The conversation is the same engine Phase 1 runs on (useBarneyChat, mode
 * `interview_wants`), so this screen is mostly the two things that make Phase 2
 * different: the re-entry guard in front of it, and the photo step after it.
 *
 * Completing the interview is what carries the user into matching — the api
 * flips them to WAITING and kicks off the first matching cycle in the same turn
 * the wants profile persists. The photo gate that follows is therefore purely
 * client-side (docs/adr/0016): matching is already running, and the photo is not
 * read until the Reveal.
 */
export default function BarneyPhase2() {
  const router = useRouter();
  // Stays null until the re-entry guard below has passed. That is what holds
  // useBarneyChat back — it starts a session as soon as it has a userId, and a
  // user who already finished Phase 2 must be redirected, not re-interviewed.
  const [userId, setUserId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // True when the guard finds a user who has already finished the wants
  // interview but has no photo (#509). They belong on this screen, but only for
  // the photo step — starting a second interview_wants session would overwrite
  // the WantedProfile they already have, which is the #497 mistake one screen
  // over.
  const [photoOnly, setPhotoOnly] = useState(false);
  // Bumped by "Try again". The guard lives entirely inside the effect, so
  // re-running it is a matter of changing what the effect depends on.
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
        // Reachable with Phase 2 already behind them: the OS back gesture, a
        // relaunch, or a second device. matchingState is the authority — it
        // leaves IDLE in the same transaction that persists the wants profile,
        // so re-running the interview here would overwrite a finished one.
        //
        // The full routeForState rather than just the matchingState half: it is
        // the same question ("where does this user belong?"), and asking all of
        // it also catches someone who reached this screen without the profile or
        // the university verification Phase 2 assumes.
        const next = routeForState(state);
        if (next !== ROUTES.phase2) {
          router.replace(next);
          return;
        }
        // Two different users land on phase2 now: one who still owes the wants
        // interview (IDLE), and one who finished it but was killed before the
        // upload. matchingState is what separates them — it leaves IDLE in the
        // same transaction that persists the wants profile.
        setPhotoOnly(state.matchingState !== "IDLE");
        setUserId(user.id);
      } catch (err) {
        // Same reasoning as the boot screen: only a 404 means the stored session
        // points at a user the api no longer has, and only that one is worth
        // dropping the session over.
        if (err instanceof ApiError && err.status === 404) {
          await clearUser();
          if (!cancelled) router.replace(ROUTES.login);
          return;
        }
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

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
    // Held at null in photo-only mode so no session is ever started: the hook
    // opens one the moment it has a userId. Also held back until the saved
    // language is known, so the session is never opened in the wrong one
    // (ADR-0037).
    userId: photoOnly || !languageReady ? null : userId,
    language,
    mode: BarneyModeSchema.enum.interview_wants,
    completionMessage: PHOTO_REQUEST_MESSAGE,
    // Barney asking for the photo, not an aside about what the app is doing.
    completionRole: "assistant",
  });

  const { appendMessage, changeLanguage } = chat;

  // Saves the choice, then has Barney restate the question already on screen in
  // the new language rather than leaving it until the next reply (ADR-0037).
  const handleLanguageChange = useCallback(
    (next: InterviewLanguage) => {
      setLanguage(next);
      void changeLanguage(next);
    },
    [setLanguage, changeLanguage]
  );

  const handleUploaded = useCallback(() => {
    appendMessage({ role: "system", content: "Moving to matching…" });
    handoffRef.current = setTimeout(() => router.replace(ROUTES.waiting), HANDOFF_DELAY_MS);
  }, [appendMessage, router]);

  // Photo-only mode has no transcript to append to, so it navigates directly
  // rather than going through handleUploaded's "Moving to matching…" bubble.
  const handlePhotoOnlyUploaded = useCallback(() => {
    router.replace(ROUTES.waiting);
  }, [router]);

  if (failed) {
    // Both escapes matter here, and for the same reason the boot screen has
    // them: this screen is reached automatically from the end of Phase 1, so a
    // transient blip on the /state call would otherwise strand the user on a
    // dead screen with nothing to press but the app switcher.
    return (
      <ScreenFailure
        title="Can't reach Wingman"
        body="The app couldn't check where you left off. Check that the api is running and that this device is on the same network, then try again."
        onRetry={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
        escape={{ label: "Sign in instead", onPress: () => router.replace(ROUTES.login) }}
      />
    );
  }

  if (!userId) return <ScreenLoading />;

  if (photoOnly) {
    // Deliberately not Barney's PHOTO_REQUEST_MESSAGE: that line promises he is
    // about to go match-making, and for this user he already has. Saying so is
    // the difference between picking up where they left off and looking like
    // the app forgot.
    return (
      <SafeAreaView className="bg-background flex-1" edges={["top"]}>
        <View className="w-full max-w-sm flex-1 self-center justify-center px-8">
          <Text className="text-foreground text-[30px] font-bold tracking-[-0.9px]">
            One thing left
          </Text>
          <Text className="text-muted-foreground mt-4 text-base leading-6">
            Your answers are saved and Barney is already out looking. He still needs a photo before
            your match can see who they are meeting.
          </Text>
        </View>
        <PhotoStep userId={userId} onUploaded={handlePhotoOnlyUploaded} />
      </SafeAreaView>
    );
  }

  return (
    // Only the top edge: the composer and the photo step draw their own bottom
    // inset so they can drop it while the keyboard is up.
    <SafeAreaView className="bg-background flex-1" edges={["top"]} testID="phase2-screen">
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
      {chat.done && !chat.initFailed && <PhotoStep userId={userId} onUploaded={handleUploaded} />}
    </SafeAreaView>
  );
}
