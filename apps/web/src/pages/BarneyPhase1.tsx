import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ChatMessage,
  InputDescriptor,
  InterviewProgress,
  InterviewSection,
  BarneyMessageResponse,
} from "@wingman/shared";
import {
  UserResponseSchema,
  BarneySessionResponseSchema,
  BarneyMessageResponseSchema,
  BarneyModeSchema,
  UserStateResponseSchema,
  createSmoothReveal,
  createTurnBubbles,
  interviewPhaseCompleted,
  type SmoothRevealTiming,
} from "@wingman/shared";
import BarneyChat from "@/components/BarneyChat";
import { useAddressForm } from "@/hooks/useAddressForm";
import { useInterviewLanguage } from "@/hooks/useInterviewLanguage";
import { streamBarneyMessage } from "@/lib/streamBarneyMessage";

const INIT_ERROR_MESSAGE = "Could not start the session. Please refresh the page.";
// Says the answer was kept, because it now is (#510). Before this, a failed
// turn cleared the composer and then offered "try again" with nothing left to
// try again with — the longer the answer, the worse the loss.
const SEND_ERROR_MESSAGE =
  "Something went wrong. Your answer is still in the box — try sending it again.";

// Pause between Barney's acknowledgement bubble and his next-question bubble, so
// the two land as separate beats (the typing indicator shows in the gap) rather
// than one wall of text.
const SPLIT_DELAY_MS = 650;

// Smooth-reveal pacing for the streaming path. `intervalMs` is the tick spacing
// and `charsPerTick` the base characters per tick (~2 chars / 18ms ≈ a natural
// typing speed); when the buffer runs far ahead we reveal proportionally faster
// (`catchupBacklog`) so long replies never lag behind. `bubbleBeatMs` is the
// pause the reveal itself inserts before a second bubble starts typing.
const REVEAL_TIMING: SmoothRevealTiming = {
  intervalMs: 18,
  charsPerTick: 2,
  catchupBacklog: 140,
  bubbleBeatMs: 500,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function BarneyPhase1() {
  const navigate = useNavigate();
  const [language, setLanguage] = useInterviewLanguage();
  const address = useAddressForm();
  // The language is read inside callbacks that must not be rebuilt when it
  // changes: `streamingTurn` feeds `startFreshSession`, and re-creating those
  // would restart the interview on every toggle. The engine switches language
  // in place from the next turn (ADR-0037), so the ref is all that is needed.
  const languageRef = useRef(language);
  // Kept up to date in an effect rather than during render — writing a ref
  // while rendering is what react-hooks/refs forbids, and a render React
  // discards would otherwise leave the wrong language behind.
  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  // `loading` is only the typing indicator: it goes off on the first revealed
  // character so the indicator gives way to the bubble Barney is typing into.
  // `busy` is "a turn is in flight" and stays on until the reveal has drained,
  // which is what the composer is gated on. Splitting them is the #491 fix:
  // while they were the same flag, the composer unlocked mid-reveal and a send
  // could start a second turn on top of one that was still typing.
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [initFailed, setInitFailed] = useState(false);
  const [section, setSection] = useState<InterviewSection | null>(null);
  const [progress, setProgress] = useState<InterviewProgress | undefined>(undefined);
  const [input, setInput] = useState<InputDescriptor | undefined>(undefined);
  const sessionIdRef = useRef<string | null>(null);
  // Captured by the init effect below so a failed turn can ask the server what
  // the user's state actually is (#511) without re-reading localStorage.
  const userIdRef = useRef<string | null>(null);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Synchronous companion to `busy`. Two clicks landing in the same React batch
  // both read the pre-update `busy`, so the state flag alone cannot serialize
  // turns; the ref flips before either handler can await anything.
  const turnActiveRef = useRef(false);

  // Pushes a turn's reply into the chat. When the engine returns both an
  // acknowledgement and a next question, they render as two separate bubbles
  // with a typing beat between them; probes/asides (question only) render as one.
  // Leaves `loading` true across the gap so the typing indicator bridges it.
  // isCancelled lets a caller (the init effect under StrictMode) bail before the
  // second bubble is pushed if the turn was superseded.
  const applyTurn = useCallback(
    async (data: BarneyMessageResponse, isCancelled?: () => boolean) => {
      const ack = data.acknowledgement ?? null;
      const question = data.question ?? null;

      if (ack && question) {
        setMessages((prev) => [...prev, { role: "assistant", content: ack }]);
        await sleep(SPLIT_DELAY_MS);
        if (isCancelled?.()) return;
        setMessages((prev) => [...prev, { role: "assistant", content: question }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: question ?? data.reply }]);
      }

      if (isCancelled?.()) return;
      setSection(data.section ?? null);
      setProgress(data.progress);
      setInput(data.input);
    },
    []
  );

  // Non-streaming turn — the fallback when server-sent events are unavailable.
  // Posts to /message and renders the whole reply at once via applyTurn.
  // turnId is the same nonce the preceding streaming attempt (if any) sent, so
  // the server recognizes this as a retry of that turn rather than a new one —
  // see the matching comment on streamingTurn below.
  const fallbackTurn = useCallback(
    async (
      sessionId: string,
      message: string,
      turnId: string,
      isCancelled?: () => boolean
    ): Promise<boolean> => {
      const res = await fetch("/api/barney/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message, turnId, language: languageRef.current }),
      });
      if (!res.ok) throw new Error("Message failed");
      const parsed = BarneyMessageResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("Unexpected message response");
      await applyTurn(parsed.data, isCancelled);
      return parsed.data.phaseComplete;
    },
    [applyTurn]
  );

  // Streaming turn — opens the SSE endpoint and reveals the reply as a smooth
  // typewriter. Rather than painting each network delta immediately (which looks
  // choppy because deltas arrive in uneven bursts), incoming text is pushed onto
  // a queue and drained to the visible bubble at a steady cadence, decoupled from
  // network timing. `loading` (the typing indicator) stays on until the first
  // character is actually revealed, bridging model latency. The section/progress/
  // input metadata from the `done` event is applied only once the reveal has fully
  // drained, so the age picker / choice chips don't pop in while Barney is still
  // "typing". If the stream never starts (SSE blocked or a transport error before
  // any content), falls back to fallbackTurn. Returns whether this turn completed
  // the phase.
  //
  // A single turnId is generated here and reused for both the streaming attempt
  // and its fallback retry. The server may have already fully processed the
  // turn (mutating the stateful InterviewEngine) even though nothing reached
  // this client — e.g. the connection drops after the response is written but
  // before any bytes are read. Without a shared turnId, the fallback's retry
  // would resubmit the same answer and the engine would silently process it
  // twice (skipping/misattributing a question). Reusing turnId lets the server
  // recognize the retry and return its cached result instead of re-running it.
  //
  // This only holds while the session lives in the registry. If the api process
  // itself restarted — the `tsx watch` case — the session is gone and the
  // fallback gets `Session not found` rather than a recovered turn. That is the
  // correct answer (the engine state it would replay against no longer exists),
  // but it means a dev-server restart mid-turn surfaces as an error, not a
  // rescue. #502's resume is what covers the user there.
  const streamingTurn = useCallback(
    async (sessionId: string, message: string, isCancelled?: () => boolean): Promise<boolean> => {
      const turnId = crypto.randomUUID();
      let receivedAny = false;
      let phaseComplete = false;
      // Held in an object so the assignment inside the stream callback survives
      // TypeScript's control-flow narrowing (a plain `let` would be seen as
      // never-reassigned and narrowed to null at the read site below).
      const meta: {
        value: {
          section: InterviewSection | null;
          progress: InterviewProgress | undefined;
          input: InputDescriptor | undefined;
        } | null;
      } = { value: null };

      // This turn's own bubbles. The reveal can only ever write to a bubble it
      // opened itself, so a tick that outlives its turn cannot reach the error
      // bubble (#487) or a later turn's bubble (#491).
      const reveal = createSmoothReveal(
        {
          ...createTurnBubbles(setMessages),
          onFirstReveal: () => setLoading(false),
          isCancelled,
        },
        REVEAL_TIMING
      );

      try {
        await streamBarneyMessage(
          { sessionId, message, turnId, language: languageRef.current },
          (event) => {
            if (isCancelled?.()) return;
            if (event.type === "bubble_start") {
              receivedAny = true;
              reveal.pushStart();
            } else if (event.type === "delta") {
              // Also marks the turn as having rendered content. `receivedAny` is
              // read below to decide whether falling back is safe, and a delta
              // reaching the reveal is enough to put text on screen — a bubble is
              // opened for it either way, by appendToLastBubble if no
              // bubble_start ever arrived.
              receivedAny = true;
              reveal.pushText(event.text);
            } else if (event.type === "done") {
              meta.value = {
                section: event.section ?? null,
                progress: event.progress,
                input: event.input,
              };
              phaseComplete = event.phaseComplete;
            } else {
              throw new Error(event.message);
            }
          }
        );
        // Network is done; let the reveal catch up before applying the metadata.
        reveal.end();
        await reveal.drained;
        if (isCancelled?.()) return phaseComplete;
        // Reaching the end of the body says nothing about whether the turn
        // finished. `done` is the server's only statement that it did, and the
        // parser deliberately skips malformed records rather than throwing — so
        // a truncated body, a dropped connection, a proxy cutting the response,
        // or the api dying mid-turn all arrive here looking exactly like
        // success: no error, no fallback, no metadata, and a user whose message
        // was posted and whose reply never comes. Treat a missing `done` as the
        // failure it is (#495).
        // Deliberately thrown into this function's own `catch` two blocks
        // down rather than handled here: that is where the recovery policy
        // lives (re-post via `fallbackTurn` when nothing streamed, surface the
        // error when a partial reply is already on screen). This is control
        // flow, not an error that escapes.
        if (!meta.value) throw new Error("Stream ended before the turn completed");
        setSection(meta.value.section);
        setProgress(meta.value.progress);
        setInput(meta.value.input);
        return phaseComplete;
      } catch (err) {
        // Only fall back if nothing streamed yet; a mid-stream failure would
        // otherwise double-render the reply.
        if (!receivedAny) return fallbackTurn(sessionId, message, turnId, isCancelled);
        // Stop the reveal before the caller appends its error bubble, or the
        // pending tick concatenates the rest of the reply onto it (#487).
        reveal.stop();
        throw err;
      }
    },
    [fallbackTurn]
  );

  useEffect(() => {
    let cancelled = false;
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

    async function init() {
      turnActiveRef.current = true;
      setBusy(true);
      setLoading(true);
      try {
        const sessionRes = await fetch("/api/barney/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            mode: BarneyModeSchema.enum.interview_self,
            language: languageRef.current,
          }),
        });
        if (!sessionRes.ok) throw new Error("Session init failed");
        const sessionParsed = BarneySessionResponseSchema.safeParse(await sessionRes.json());
        if (!sessionParsed.success) throw new Error("Unexpected session response");
        if (cancelled) return;
        sessionIdRef.current = sessionParsed.data.sessionId;

        // A completed profile can make the very first ("start") reply already
        // phaseComplete — honour the same transition the handleSend path does, so
        // the user isn't stranded on Phase 1 (the streaming refactor #236 dropped
        // this on the init path).
        const phaseComplete = await streamingTurn(
          sessionParsed.data.sessionId,
          "start",
          () => cancelled
        );
        if (!cancelled && phaseComplete) {
          setDone(true);
          setMessages((prev) => [...prev, { role: "system", content: "Moving to Phase 2..." }]);
          transitionTimeoutRef.current = setTimeout(() => navigate("/barney/phase2"), 1500);
        }
      } catch {
        if (cancelled) return;
        setInitFailed(true);
        setMessages([{ role: "assistant", content: INIT_ERROR_MESSAGE }]);
      } finally {
        // Symmetric with the state resets below: a cancelled init must not
        // clear the lock, because under StrictMode the remount's init() is
        // already running with it set and the cleanup released it for that
        // remount. Clearing here would unlock the composer mid-turn.
        if (!cancelled) {
          turnActiveRef.current = false;
          setLoading(false);
          setBusy(false);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
      // Release the turn lock for the remount: under StrictMode this cleanup
      // runs before the second init(), and the first turn's finally may not
      // have landed yet.
      turnActiveRef.current = false;
      if (transitionTimeoutRef.current !== null) clearTimeout(transitionTimeoutRef.current);
    };
    // navigate and streamingTurn are stable — this effect runs once on mount.
  }, [navigate, streamingTurn]);

  // The Phase 1 -> Phase 2 hand-off, shared by the two paths that can reach it
  // from a turn: a `done` event saying the phase completed, and the #511
  // recovery below, which finds out from the server instead. Both must
  // transition identically — a user who was rescued should not be able to tell.
  // (The init effect above inlines the same transition; it is declared before
  // this callback exists, and its completion path is not what #511 breaks.)
  const completePhase = useCallback(() => {
    setDone(true);
    setMessages((prev) => [...prev, { role: "system", content: "Moving to Phase 2..." }]);
    transitionTimeoutRef.current = setTimeout(() => navigate("/barney/phase2"), 1500);
  }, [navigate]);

  // Asks the server whether Phase 1 has already finished (#511). `phaseComplete`
  // only ever arrives on the stream's `done` event, so a stream that dies after
  // the deltas but before `done` leaves the client believing the turn failed
  // while the api has already persisted the profile and moved the user on.
  // Re-posting cannot recover it — the engine has advanced — so the only honest
  // question left is to ask the server.
  //
  // Fails closed: any error here means we could not confirm completion, and the
  // turn error is shown as before. Claiming the phase finished on a failed
  // lookup would skip someone past an interview they still owe.
  const phaseCompletedOnServer = useCallback(async (): Promise<boolean> => {
    const userId = userIdRef.current;
    if (!userId) return false;
    try {
      const res = await fetch(`/api/users/${userId}/state`);
      if (!res.ok) return false;
      const parsed = UserStateResponseSchema.safeParse(await res.json());
      if (!parsed.success) return false;
      return interviewPhaseCompleted(BarneyModeSchema.enum.interview_self, parsed.data);
    } catch {
      return false;
    }
  }, []);

  // Resolves false when the turn failed, which is the composer's cue to put the
  // draft back (#510). A refused send — no session, a turn already in flight —
  // resolves false too: nothing was sent, so nothing should be discarded.
  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      const sessionId = sessionIdRef.current;
      // Gated on `busy`, not `loading`: the turn is not over until its reveal has
      // drained, and starting a second turn on top of one still typing is #491.
      if (!sessionId || turnActiveRef.current || busy || done) return false;
      turnActiveRef.current = true;

      setMessages((prev) => [...prev, { role: "user", content: text }]);
      // Clear the input control until the next turn tells us what to render, so a
      // choice/age control doesn't linger against the wrong question.
      setInput(undefined);
      setBusy(true);
      setLoading(true);

      try {
        const phaseComplete = await streamingTurn(sessionId, text);
        if (phaseComplete) {
          completePhase();
        }
        return true;
      } catch {
        // The turn that completes the phase is exactly the one whose stream is
        // most likely to be cut short, because it is the longest. Before
        // rendering a dead end, ask whether the api already finished (#511).
        if (await phaseCompletedOnServer()) {
          completePhase();
          // True, not false: the phase really did complete, so the composer must
          // not put the draft back (#510) — that would leave the Phase 1 answer
          // sitting in the box as the user lands on Phase 2.
          return true;
        }
        setMessages((prev) => [...prev, { role: "assistant", content: SEND_ERROR_MESSAGE }]);
        return false;
      } finally {
        turnActiveRef.current = false;
        setLoading(false);
        setBusy(false);
      }
    },
    [busy, done, streamingTurn, completePhase, phaseCompletedOnServer]
  );

  // "Back" control (#chat-flow): re-runs the turn with a back command so the
  // engine rewinds to the previous question. Deliberately adds no user bubble —
  // it reads as navigation, not a chat message — and never completes the phase.
  const handleBack = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || turnActiveRef.current || busy || done) return;
    turnActiveRef.current = true;
    setInput(undefined);
    setBusy(true);
    setLoading(true);
    try {
      await streamingTurn(sessionId, "go back");
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: SEND_ERROR_MESSAGE }]);
    } finally {
      turnActiveRef.current = false;
      setLoading(false);
      setBusy(false);
    }
  }, [busy, done, streamingTurn]);

  return (
    <div className="flex h-screen flex-col">
      <BarneyChat
        messages={messages}
        onSend={handleSend}
        loading={loading}
        busy={busy}
        disabled={done || initFailed}
        section={section}
        progress={progress}
        input={input}
        onBack={handleBack}
        language={language}
        onLanguageChange={setLanguage}
        address={address}
      />
    </div>
  );
}
