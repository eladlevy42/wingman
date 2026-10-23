import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ChatMessage,
  InputDescriptor,
  InterviewProgress,
  InterviewSection,
} from "@wingman/shared";
import {
  UserResponseSchema,
  BarneySessionResponseSchema,
  BarneyMessageResponseSchema,
  BarneyModeSchema,
  UserStateResponseSchema,
} from "@wingman/shared";
import BarneyChat from "@/components/BarneyChat";
import { useAddressForm } from "@/hooks/useAddressForm";
import { useInterviewLanguage } from "@/hooks/useInterviewLanguage";
import { Button } from "@/components/ui/button";
import { redirectPathForMatchingState } from "@/lib/redirectPathForState";

const INIT_ERROR_MESSAGE = "Could not start the session. Please refresh the page.";
// Says the answer was kept, because it now is (#510) — see BarneyPhase1 for
// the reasoning. Phase 2 is included so the two interviews behave the same on
// both clients: mobile's Phase 2 shares useBarneyChat with Phase 1 and so was
// fixed by the same change there.
const SEND_ERROR_MESSAGE =
  "Something went wrong. Your answer is still in the box — try sending it again.";

// Scripted (non-LLM) follow-up shown once Phase 2 completes — see
// docs/adr/0016-post-interview-photo-request.md for why this is hardcoded
// copy rather than a real model turn, even though it renders as a "Barney"
// chat bubble like every other assistant message.
const PHOTO_REQUEST_MESSAGE =
  "One more thing before I go match-making — can you upload a current photo? I want your match to really see who they're meeting.";
const PHOTO_UPLOAD_ERROR = "Could not upload your photo — please try again.";
// Where redirectPathForMatchingState sends the matching-pool states. A missing
// photo is only worth going back for while the user is still waiting to be
// matched — see the note on AWAITING_MATCH in redirectPathForState (#509).
const AWAITING_MATCH_PATHS: ReadonlySet<string> = new Set(["/waiting"]);

const ACCEPTED_PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export default function BarneyPhase2() {
  const navigate = useNavigate();
  const [language, setLanguage] = useInterviewLanguage();
  const address = useAddressForm();
  // Read from a ref inside the turn callbacks so toggling the flag never
  // rebuilds them (and so never restarts the interview) — the engine switches
  // language in place from the next turn (ADR-0037).
  const languageRef = useRef(language);
  // Kept up to date in an effect rather than during render — writing a ref
  // while rendering is what react-hooks/refs forbids, and a render React
  // discards would otherwise leave the wrong language behind.
  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [initFailed, setInitFailed] = useState(false);
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUploaded, setPhotoUploaded] = useState(false);
  // Set when the guard finds a user who already finished the wants interview
  // but never uploaded a photo (#509) — they belong here, but only for the
  // photo step. Holds where to send them once it lands, since matching has
  // already moved on without them.
  const [photoOnlyNext, setPhotoOnlyNext] = useState<string | null>(null);
  // Interview controls (#chat-flow): Phase 2 now drives the age picker / distance
  // choice chips / progress bar from the engine's per-turn input descriptor, the
  // same way Phase 1 does.
  const [section, setSection] = useState<InterviewSection | null>(null);
  const [progress, setProgress] = useState<InterviewProgress | undefined>(undefined);
  const [input, setInput] = useState<InputDescriptor | undefined>(undefined);
  const sessionIdRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("user");
    if (!raw) {
      navigate("/login", { replace: true });
      return;
    }
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      navigate("/login", { replace: true });
      return;
    }
    const parsed = UserResponseSchema.safeParse(stored);
    if (!parsed.success) {
      navigate("/login", { replace: true });
      return;
    }
    const userId = parsed.data.id;
    userIdRef.current = userId;

    let cancelled = false;

    async function init() {
      setLoading(true);
      try {
        // Guard against restarting an already-finished Phase 2 interview —
        // reachable via back button, a stale tab, or a bookmarked URL once
        // matchingState has moved past IDLE (see redirectPathForState).
        const stateRes = await fetch(`/api/users/${userId}/state`);
        if (!stateRes.ok) throw new Error("State fetch failed");
        const stateParsed = UserStateResponseSchema.safeParse(await stateRes.json());
        if (!stateParsed.success) throw new Error("Unexpected state response");
        if (cancelled) return;
        const nextPath = redirectPathForMatchingState(stateParsed.data.matchingState);
        if (nextPath !== "/barney/phase2") {
          // Finished the interview but never got a photo up: stay, show only
          // the photo step. Starting a second interview_wants session would
          // overwrite the WantedProfile they already have.
          if (stateParsed.data.hasPhoto === false && AWAITING_MATCH_PATHS.has(nextPath)) {
            setPhotoOnlyNext(nextPath);
            setLoading(false);
            return;
          }
          navigate(nextPath, { replace: true });
          return;
        }

        const sessionRes = await fetch("/api/barney/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            mode: BarneyModeSchema.enum.interview_wants,
            language: languageRef.current,
          }),
        });
        if (!sessionRes.ok) throw new Error("Session init failed");
        const sessionParsed = BarneySessionResponseSchema.safeParse(await sessionRes.json());
        if (!sessionParsed.success) throw new Error("Unexpected session response");
        if (cancelled) return;
        sessionIdRef.current = sessionParsed.data.sessionId;

        const msgRes = await fetch("/api/barney/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionParsed.data.sessionId,
            message: "start",
            language: languageRef.current,
          }),
        });
        if (!msgRes.ok) throw new Error("First message failed");
        const msgParsed = BarneyMessageResponseSchema.safeParse(await msgRes.json());
        if (!msgParsed.success) throw new Error("Unexpected message response");
        if (cancelled) return;
        setMessages([{ role: "assistant", content: msgParsed.data.reply }]);
        setSection(msgParsed.data.section ?? null);
        setProgress(msgParsed.data.progress);
        setInput(msgParsed.data.input);
        if (msgParsed.data.phaseComplete) {
          // Set done before the timeout so handleSend can't fire in the gap.
          setDone(true);
          setMessages((prev) => [...prev, { role: "assistant", content: PHOTO_REQUEST_MESSAGE }]);
        }
      } catch {
        if (cancelled) return;
        setInitFailed(true);
        setMessages([{ role: "assistant", content: INIT_ERROR_MESSAGE }]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
      if (transitionTimeoutRef.current !== null) clearTimeout(transitionTimeoutRef.current);
    };
    // navigate is a stable reference — this effect runs once on mount only.
  }, [navigate]);

  // Resolves false when the turn failed, which is the composer's cue to put the
  // draft back (#510).
  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || loading || done) return false;

      setMessages((prev) => [...prev, { role: "user", content: text }]);
      // Clear the control until the next turn says what to render, so a choice/age
      // control doesn't linger against the wrong question.
      setInput(undefined);
      setLoading(true);

      try {
        const res = await fetch("/api/barney/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: text, language: languageRef.current }),
        });
        if (!res.ok) throw new Error("Message failed");
        const msgParsed = BarneyMessageResponseSchema.safeParse(await res.json());
        if (!msgParsed.success) throw new Error("Unexpected message response");
        setMessages((prev) => [...prev, { role: "assistant", content: msgParsed.data.reply }]);
        setSection(msgParsed.data.section ?? null);
        setProgress(msgParsed.data.progress);
        setInput(msgParsed.data.input);
        if (msgParsed.data.phaseComplete) {
          // Set done before the timeout so handleSend can't fire in the gap.
          setDone(true);
          setMessages((prev) => [...prev, { role: "assistant", content: PHOTO_REQUEST_MESSAGE }]);
        }
        return true;
      } catch {
        setMessages((prev) => [...prev, { role: "assistant", content: SEND_ERROR_MESSAGE }]);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [loading, done]
  );

  // "Back" control (#chat-flow): re-runs the turn with a back command so the
  // engine rewinds to the previous question. Adds no user bubble — it reads as
  // navigation, not a chat message — and never completes the phase.
  const handleBack = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || loading || done) return;
    setInput(undefined);
    setLoading(true);
    try {
      const res = await fetch("/api/barney/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: "go back", language: languageRef.current }),
      });
      if (!res.ok) throw new Error("Message failed");
      const msgParsed = BarneyMessageResponseSchema.safeParse(await res.json());
      if (!msgParsed.success) throw new Error("Unexpected message response");
      setMessages((prev) => [...prev, { role: "assistant", content: msgParsed.data.reply }]);
      setSection(msgParsed.data.section ?? null);
      setProgress(msgParsed.data.progress);
      setInput(msgParsed.data.input);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: SEND_ERROR_MESSAGE }]);
    } finally {
      setLoading(false);
    }
  }, [loading, done]);

  const handlePhotoSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after an error.
    event.target.value = "";
    if (!file) return;

    setPhotoError(null);
    if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) {
      setPhotoError("That doesn't look like a photo — try a JPG, PNG, or WEBP.");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("That photo's a bit too big — try one under 5MB.");
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setPhotoDataUrl(dataUrl);
    } catch {
      setPhotoError("Could not read that file — please try again.");
    }
  }, []);

  const handlePhotoUpload = useCallback(async () => {
    const userId = userIdRef.current;
    if (!userId || !photoDataUrl || photoUploading) return;

    setPhotoUploading(true);
    setPhotoError(null);
    try {
      const res = await fetch(`/api/users/${userId}/photo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photoUrl: photoDataUrl }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          Array.isArray(body.error) && typeof body.error[0]?.message === "string"
            ? body.error[0].message
            : PHOTO_UPLOAD_ERROR;
        setPhotoError(message);
        return;
      }
      setPhotoUploaded(true);
      if (photoOnlyNext) {
        // No transcript to append to, and matching has already started — send
        // them back to where their state says they belong, not through the
        // post-interview completion hand-off.
        transitionTimeoutRef.current = setTimeout(() => navigate(photoOnlyNext), 1500);
        return;
      }
      setMessages((prev) => [...prev, { role: "system", content: "Moving to matching..." }]);
      transitionTimeoutRef.current = setTimeout(() => navigate("/completion"), 1500);
    } catch {
      setPhotoError("Network error — please try again.");
    } finally {
      setPhotoUploading(false);
    }
  }, [photoDataUrl, photoUploading, navigate, photoOnlyNext]);

  const photoOnly = photoOnlyNext !== null;
  const showPhotoStep = photoOnly || (done && !initFailed);

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-border px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold text-foreground">
          {photoOnly ? "One thing left" : "Now tell me what you are looking for."}
        </h1>
      </header>
      {photoOnly ? (
        // Deliberately not Barney's photo request line: that one promises he is
        // about to go match-making, and for this user he already has.
        <div className="flex flex-1 items-center justify-center px-4 sm:px-6">
          <p className="max-w-sm text-center text-sm leading-6 text-muted-foreground">
            Your answers are saved and Barney is already out looking. He still needs a photo before
            your match can see who they are meeting.
          </p>
        </div>
      ) : (
        <BarneyChat
          messages={messages}
          onSend={handleSend}
          loading={loading}
          disabled={done || initFailed}
          section={section}
          progress={progress}
          input={input}
          onBack={handleBack}
          language={language}
          onLanguageChange={setLanguage}
          address={address}
        />
      )}
      {showPhotoStep && (
        <div className="flex flex-col items-center gap-3 border-t border-border px-4 py-4 sm:px-6 animate-in fade-in duration-200">
          {photoUploaded ? (
            <p className="text-sm text-foreground">Photo saved!</p>
          ) : (
            <>
              {photoDataUrl && (
                <img
                  src={photoDataUrl}
                  alt="Your selected photo"
                  className="h-20 w-20 rounded-full border border-border object-cover animate-in fade-in duration-200"
                />
              )}
              <div className="flex gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handlePhotoSelect}
                  aria-label={photoDataUrl ? "Choose a different photo" : "Choose a photo"}
                />
                <Button
                  variant="ghost"
                  type="button"
                  disabled={photoUploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {photoDataUrl ? "Choose a different photo" : "Choose photo"}
                </Button>
                {photoDataUrl && (
                  <Button onClick={handlePhotoUpload} disabled={photoUploading}>
                    {photoUploading ? "Uploading…" : "Upload"}
                  </Button>
                )}
              </div>
              {photoError && <p className="text-sm text-destructive">{photoError}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
