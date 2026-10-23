import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ChatMessage } from "@wingman/shared";
import {
  UserResponseSchema,
  UserStateResponseSchema,
  BarneySessionResponseSchema,
  BarneyMessageResponseSchema,
  BarneyModeSchema,
} from "@wingman/shared";
import AppLayout from "@/components/AppLayout";
import BarneyChat from "@/components/BarneyChat";

const INIT_ERROR_MESSAGE = "Could not start the session. Please refresh the page.";
const SEND_ERROR_MESSAGE = "Something went wrong. Please try again.";
const COMPLETION_MESSAGE = "Thanks, Barney's got your back for next time.";
const REDIRECT_DELAY_MS = 1500;

function readStoredUserId(): string | null {
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

export default function Debrief() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [initFailed, setInitFailed] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // matchId comes from GET /api/users/:id/state, same channel as Pitch (#53) —
  // only auto-triggers the session when followUpState is DATE_PASSED (#67);
  // otherwise this page was reached before a debrief is actually due, so send
  // the user back to /waiting instead of starting a session.
  useEffect(() => {
    const userId = readStoredUserId();
    if (!userId) {
      navigate("/login", { replace: true });
      return;
    }

    let cancelled = false;

    async function init() {
      setLoading(true);
      try {
        const stateRes = await fetch(`/api/users/${userId}/state`);
        if (!stateRes.ok) throw new Error("Could not load match state");
        const stateParsed = UserStateResponseSchema.safeParse(await stateRes.json());
        if (!stateParsed.success) throw new Error("Unexpected state response");
        if (cancelled) return;

        const { matchId, followUpState } = stateParsed.data;
        if (followUpState !== "DATE_PASSED" || !matchId) {
          navigate("/waiting", { replace: true });
          return;
        }

        const sessionRes = await fetch("/api/barney/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, mode: BarneyModeSchema.enum.debrief, matchId }),
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
        if (msgParsed.data.phaseComplete) {
          setDone(true);
          setMessages((prev) => [...prev, { role: "system", content: COMPLETION_MESSAGE }]);
          transitionTimeoutRef.current = setTimeout(() => navigate("/waiting"), REDIRECT_DELAY_MS);
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

  const handleSend = useCallback(
    async (text: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || loading || done) return;

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
        if (msgParsed.data.phaseComplete) {
          setDone(true);
          setMessages((prev) => [...prev, { role: "system", content: COMPLETION_MESSAGE }]);
          transitionTimeoutRef.current = setTimeout(() => navigate("/waiting"), REDIRECT_DELAY_MS);
        }
      } catch {
        setMessages((prev) => [...prev, { role: "assistant", content: SEND_ERROR_MESSAGE }]);
      } finally {
        setLoading(false);
      }
    },
    [loading, done, navigate]
  );

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="border-b border-border px-4 py-4 sm:px-6">
          <h1 className="text-lg font-semibold text-foreground">
            How did your date go? Tell Barney everything.
          </h1>
        </header>
        <BarneyChat
          messages={messages}
          onSend={handleSend}
          loading={loading}
          disabled={initFailed || done}
        />
      </div>
    </AppLayout>
  );
}
