import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ChatMessage } from "@wingman/shared";
import {
  UserResponseSchema,
  UserStateResponseSchema,
  BarneySessionResponseSchema,
  BarneyMessageResponseSchema,
  BarneyModeSchema,
  MatchPhotoResponseSchema,
} from "@wingman/shared";

export const TOTAL_QUESTIONS = 3;
const INIT_ERROR_MESSAGE = "Could not start the session. Please refresh the page.";
const SEND_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function readStoredUserId(): string | null {
  const raw = localStorage.getItem("user");
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = UserResponseSchema.safeParse(stored);
  return parsed.success ? parsed.data.id : null;
}

// Owns the pitch chat session: init (session + first message), the match
// reveal fetch (ADR-0022), and sending genie questions. The post-decision
// poll and decide action live in usePitchDecision — a distinct concern once
// the chat is over.
export function usePitchSession() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [initFailed, setInitFailed] = useState(false);
  const [questionsLeft, setQuestionsLeft] = useState(TOTAL_QUESTIONS);
  const [matchPhotoUrl, setMatchPhotoUrl] = useState<string | null>(null);
  // The match reveal (ADR-0022): name + education shown on the opening
  // "Introducing…" card. showIntro gates that card ahead of the genie chat.
  const [showIntro, setShowIntro] = useState(true);
  const [partnerName, setPartnerName] = useState<string | null>(null);
  const [education, setEducation] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const matchIdRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  // matchId comes from GET /api/users/:id/state (the currently MATCHED Match
  // record's id) — there is no other channel yet that delivers it to the
  // client. See issue #53. Required by POST /api/barney/session for mode
  // "pitch" (docs/adr/0014).
  useEffect(() => {
    const userId = readStoredUserId();
    if (!userId) {
      navigate("/login", { replace: true });
      return;
    }
    userIdRef.current = userId;

    let cancelled = false;

    async function init() {
      setLoading(true);
      try {
        const stateRes = await fetch(`/api/users/${userId}/state`);
        if (!stateRes.ok) throw new Error("Could not load match state");
        const stateParsed = UserStateResponseSchema.safeParse(await stateRes.json());
        if (!stateParsed.success) throw new Error("Unexpected state response");
        if (cancelled) return;
        const matchId = stateParsed.data.matchId;
        if (!matchId) throw new Error("No match found for this user");
        matchIdRef.current = matchId;

        const sessionRes = await fetch("/api/barney/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, mode: BarneyModeSchema.enum.pitch, matchId }),
        });
        if (!sessionRes.ok) throw new Error("Session init failed");
        const sessionParsed = BarneySessionResponseSchema.safeParse(await sessionRes.json());
        if (!sessionParsed.success) throw new Error("Unexpected session response");
        if (cancelled) return;
        sessionIdRef.current = sessionParsed.data.sessionId;

        const msgRes = await fetch("/api/barney/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionParsed.data.sessionId, message: "start" }),
        });
        if (!msgRes.ok) throw new Error("First message failed");
        const msgParsed = BarneyMessageResponseSchema.safeParse(await msgRes.json());
        if (!msgParsed.success) throw new Error("Unexpected message response");
        if (cancelled) return;
        setMessages([{ role: "assistant", content: msgParsed.data.reply }]);
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
    };
    // navigate is a stable reference — this effect runs once on mount only.
  }, [navigate]);

  // Load the match reveal up front (ADR-0022): the partner's name + education
  // drive the opening "Introducing…" card, and the photo is reused on the
  // decision screen. Fetched once on mount, in parallel with the session init,
  // and non-fatally: if it fails, the pitch still runs (card falls back to
  // "Your match", decision still works without the photo).
  useEffect(() => {
    const userId = readStoredUserId();
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/users/${userId}/match-photo`);
        if (!res.ok) return;
        const parsed = MatchPhotoResponseSchema.safeParse(await res.json());
        if (!cancelled && parsed.success) {
          setMatchPhotoUrl(parsed.data.photoUrl);
          setPartnerName(parsed.data.partnerName);
          setEducation(parsed.data.education);
        }
      } catch {
        // Non-fatal — the reveal card and decision degrade gracefully.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSend = useCallback(
    async (text: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || loading || questionsLeft <= 0) return;

      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setLoading(true);

      try {
        const res = await fetch("/api/barney/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: text }),
        });
        if (!res.ok) throw new Error("Message failed");
        const msgParsed = BarneyMessageResponseSchema.safeParse(await res.json());
        if (!msgParsed.success) throw new Error("Unexpected message response");
        setMessages((prev) => [...prev, { role: "assistant", content: msgParsed.data.reply }]);
        setQuestionsLeft((prev) => Math.max(0, prev - 1));
      } catch {
        setMessages((prev) => [...prev, { role: "assistant", content: SEND_ERROR_MESSAGE }]);
      } finally {
        setLoading(false);
      }
    },
    [loading, questionsLeft]
  );

  return {
    totalQuestions: TOTAL_QUESTIONS,
    messages,
    loading,
    initFailed,
    questionsLeft,
    matchPhotoUrl,
    showIntro,
    setShowIntro,
    partnerName,
    education,
    handleSend,
    matchIdRef,
    userIdRef,
  };
}
