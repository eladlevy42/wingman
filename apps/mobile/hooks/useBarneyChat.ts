import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import {
  BarneyLanguageResponseSchema,
  BarneyMessageResponseSchema,
  BarneySessionResponseSchema,
  createSmoothReveal,
  createTurnBubbles,
  interviewPhaseCompleted,
  type BarneyMessageResponse,
  type BarneyMode,
  type ChatMessage,
  type InputDescriptor,
  type InterviewProgress,
  type InterviewLanguage,
  type InterviewSection,
  type SmoothRevealTiming,
  UserStateResponseSchema,
} from "@wingman/shared";
import { ServerReportedError, apiRequest, isServerAuthoredError } from "~/lib/api";
import {
  clearBarneySession,
  loadBarneySession,
  matchesConversation,
  saveBarneySession,
} from "~/lib/barneySession";
import { streamBarneyMessage } from "~/lib/streamBarneyMessage";

// Deliberately carries no recovery instruction. It used to say "Pull down to
// try again", adapted from the web copy where reloading the page really is
// available — but pull-to-refresh was never implemented on this screen, and on
// a device with no address bar that left force-quitting the app as the only way
// out (#494). The affordance belongs to whichever screen renders the failure,
// via retryInit; the hook only reports that the session could not be started.
export const INIT_ERROR_MESSAGE = "Could not start the session.";
export const SEND_ERROR_MESSAGE =
  "Something went wrong. Your answer is still in the box — try sending it again.";

// Appended to a server-authored turn error ("AI service temporarily
// unavailable", say) so those keep their specific cause but still tell the user
// their answer survived (#510). SEND_ERROR_MESSAGE already says it itself.
export const DRAFT_KEPT_SUFFIX = " Your answer is still in the box.";

// What the api's route writes when a sessionId is unknown to it — because the
// process restarted, or the session was evicted after its idle TTL. Matched so a
// resumed conversation whose server side is gone can say something true and
// clear the snapshot, rather than repeating "Session not found" at every turn.
// Says what happened, not what to do: recoverLostSession() has already started
// the replacement interview by the time this renders, and the greeting streams
// into the transcript directly underneath it. Telling the user to restart the
// app would be instructing them to undo a recovery that already worked — the
// same class of bug as #494's "pull down to try again" on a screen with no
// pull-to-refresh.
export const SESSION_LOST_MESSAGE =
  "That interview expired, so we're starting a new one — your earlier answers couldn't be recovered.";
const SESSION_NOT_FOUND = "Session not found";

// Pause between Barney's acknowledgement bubble and his next-question bubble, so
// the two land as separate beats (the typing indicator shows in the gap) rather
// than one wall of text.
const SPLIT_DELAY_MS = 650;

// Smooth-reveal pacing for the streaming path. `intervalMs` is the tick spacing
// and `charsPerTick` the base characters per tick; when the buffer runs far
// ahead we reveal proportionally faster (`catchupBacklog`) so long replies never
// lag behind. `bubbleBeatMs` is the pause the reveal itself inserts before a
// second bubble starts typing.
//
// Values are the web client's, unchanged: the pacing is a product decision about
// how Barney reads, not a platform detail, and the two clients should feel the
// same. The scheduler itself now comes from @wingman/shared for the same reason
// — this hook used to carry its own copy, and the drift between the copies is
// what let #487 sit unfixed on web after mobile was fixed.
const REVEAL_TIMING: SmoothRevealTiming = {
  intervalMs: 18,
  charsPerTick: 2,
  catchupBacklog: 140,
  bubbleBeatMs: 500,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prefer whatever the server said went wrong. A turn can fail for reasons the
// person can act on — the api is unreachable, or the AI backend is down — and
// flattening all of them to "Something went wrong" hides the one detail that
// would have told them (or whoever is debugging) which it was.
function turnErrorMessage(err: unknown): string {
  return isServerAuthoredError(err) ? err.message + DRAFT_KEPT_SUFFIX : SEND_ERROR_MESSAGE;
}

// The api no longer knows this sessionId. Reaches the client two ways depending
// on which endpoint the turn ended up on: an ApiError(404) from the /message
// fallback, or a ServerReportedError from the stream's in-band error event.
// Matched on the message both routes write, since the streamed one carries no
// status to check.
function isSessionLost(err: unknown): boolean {
  return isServerAuthoredError(err) && err.message === SESSION_NOT_FOUND;
}

export interface UseBarneyChat {
  /**
   * The conversation currently open, or null before init settles and after a
   * lost session is dropped.
   *
   * Exposed so a caller can scope per-conversation state to it. A resumed
   * conversation keeps its id, a fresh one gets a new one, and an expired
   * snapshot produces the latter — so keying on this gives that state exactly
   * the conversation's own lifetime for free, rather than a second expiry rule
   * that can disagree with the snapshot's.
   */
  sessionId: string | null;
  messages: ChatMessage[];
  /** The typing indicator: on until the turn's first character is revealed. */
  loading: boolean;
  /**
   * A turn is in flight, reveal included. What the composer is gated on —
   * `loading` goes off on the first revealed character, and sending in the
   * second or so of typing that follows used to start a turn on top of one
   * still being revealed (#491).
   */
  busy: boolean;
  done: boolean;
  initFailed: boolean;
  section: InterviewSection | null;
  progress: InterviewProgress | undefined;
  input: InputDescriptor | undefined;
  /**
   * Sends one turn. Resolves true when the turn landed and false when it did
   * not — the composer already relies on that to put a failed draft back, and
   * the pitch relies on it to avoid charging a question for a turn the api
   * never answered (#463).
   *
   * The implementation has always returned this; the type used to say `void`,
   * which quietly discarded the outcome at the boundary.
   */
  send: (text: string) => Promise<boolean>;
  goBack: () => void;
  /**
   * Tells the api the user switched language and replaces the conversation on
   * screen with the pending question, and its answer controls, in the new
   * language (ADR-0037). Best-effort: every turn carries the language anyway, so if this
   * fails the switch still lands on Barney's next reply.
   */
  changeLanguage: (language: InterviewLanguage) => Promise<void>;
  /**
   * Start the session over after `initFailed`. A no-op otherwise, so it can be
   * wired straight to a button without the caller guarding it.
   *
   * Session init is the one failure the conversation cannot recover from on its
   * own: there is no sessionId, so `send` and `goBack` both return immediately
   * and every input control is disabled. Without this the screen is a dead end
   * (#494).
   */
  retryInit: () => void;
  // Appends a bubble the conversation itself did not produce. The transcript is
  // the hook's state, so a screen that has something to say in it — Phase 2's
  // "Moving to matching…" once the photo lands — has to go through here rather
  // than keeping a second list of its own and rendering the two concatenated.
  appendMessage: (message: ChatMessage) => void;
}

/**
 * Owns a Barney conversation: session creation, one turn per send, the
 * streaming typewriter reveal, and the non-streaming fallback.
 *
 * Extracted as a hook rather than living in the Phase 1 screen (where the web
 * client keeps it) because every later conversational surface — Phase 2, the
 * pitch, the debrief — runs exactly this loop against the same endpoints and
 * differs only in `mode` and what happens on completion. Slices 2-5 should be
 * able to call this and write a screen, not re-port the turn engine.
 *
 * `onPhaseComplete` fires once, on the turn where the mode's completion tool
 * fired. The hook keeps its own state consistent (freezing input via `done`)
 * and leaves navigation to the caller.
 */
export function useBarneyChat(options: {
  userId: string | null;
  mode: BarneyMode;
  // The interview language, sent with the session and with every turn so the
  // flag toggle takes effect from the next reply (ADR-0037). Read through a ref
  // below, so changing it never rebuilds the turn callbacks and never restarts
  // the conversation.
  language?: InterviewLanguage;
  matchId?: string;
  // Appended as a bubble the moment the phase completes, so the chat itself says
  // what is about to happen instead of the screen going quiet while the caller
  // navigates away. Lives here rather than in the screen because the hook owns
  // `messages`.
  completionMessage?: string;
  // Who the completion bubble is from. Defaults to "system" — the italic
  // "Moving to Phase 2…" aside Phase 1 shows. Phase 2 overrides it to
  // "assistant" because its completion line is Barney asking for the match
  // photo, which docs/adr/0016 requires to read as a Barney bubble (scripted UI
  // copy, not a model turn).
  completionRole?: ChatMessage["role"];
  onPhaseComplete?: () => void;
}): UseBarneyChat {
  const { userId, mode, matchId, completionMessage, completionRole, onPhaseComplete } = options;
  const language = options.language;
  const languageRef = useRef(language);
  // Kept up to date in an effect rather than during render — writing a ref
  // while rendering is what react-hooks/refs forbids, and a render React
  // discards would otherwise leave the wrong language behind.
  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped by retryInit. The whole init decision lives inside the effect below,
  // so re-running it is a matter of changing what the effect depends on — the
  // same shape app/index.tsx uses for its own boot retry.
  const [attempt, setAttempt] = useState(0);

  const [done, setDone] = useState(false);
  const [initFailed, setInitFailed] = useState(false);
  const [section, setSection] = useState<InterviewSection | null>(null);
  const [progress, setProgress] = useState<InterviewProgress | undefined>(undefined);
  const [input, setInput] = useState<InputDescriptor | undefined>(undefined);
  // Bumped once per completed turn. The persistence effect below keys off this
  // rather than off `messages`, which changes on every 18ms reveal tick — the
  // conversation is worth writing to storage at turn boundaries, not 50 times a
  // second.
  const [turnBoundary, setTurnBoundary] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  // A render-visible mirror of the ref above. The ref stays the source of truth
  // for the async paths — it flips synchronously, before anything awaits — but
  // a screen that has to key state to *this* conversation needs the identity to
  // arrive as a render, not as a mutation nothing is subscribed to. The pitch's
  // question allowance is the first such caller (#463): it survives a reload by
  // being stored against the session it was spent in, so it has to know when
  // the hook resumed the old conversation and when it opened a new one.
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const setSessionId = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setCurrentSessionId(id);
  }, []);
  // The turnBoundary value already written to storage, so the persistence
  // effect can tell a real turn boundary from the many renders a reveal causes.
  const persistedBoundaryRef = useRef(0);
  // Synchronous companion to `busy`. Two taps landing in the same React batch
  // both read the pre-update `busy`, so the state flag alone cannot serialize
  // turns; the ref flips before either handler can await anything.
  const turnActiveRef = useRef(false);

  // Lets an in-flight reveal stop when the screen goes away. The init path has
  // its own effect-scoped `cancelled`; send/goBack had nothing, so a reveal
  // still draining when the phase completes kept calling setMessages against a
  // screen that had already navigated on.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const unmounted = useCallback(() => !mountedRef.current, []);

  // Held in refs so a caller passing an inline arrow function (or an inline
  // string) does not restart the session on every render. Kept up to date in an
  // effect rather than during render, so a render that React discards cannot
  // leave a stale callback behind.
  const onPhaseCompleteRef = useRef(onPhaseComplete);
  const completionMessageRef = useRef(completionMessage);
  const completionRoleRef = useRef(completionRole);
  useEffect(() => {
    onPhaseCompleteRef.current = onPhaseComplete;
    completionMessageRef.current = completionMessage;
    completionRoleRef.current = completionRole;
  }, [onPhaseComplete, completionMessage, completionRole]);

  // Single exit path for a turn that finished the phase: freeze the input, say
  // so in the transcript, then hand off. Both the init turn and the send path
  // route through here so they can never drift apart.
  const completePhase = useCallback(() => {
    setDone(true);
    // The phase is over, so there is nothing left to resume — and leaving the
    // snapshot behind would offer to resume a finished interview on next launch.
    void clearBarneySession();
    const notice = completionMessageRef.current;
    const role = completionRoleRef.current ?? "system";
    if (notice) setMessages((prev) => [...prev, { role, content: notice }]);
    onPhaseCompleteRef.current?.();
  }, []);

  // Pushes a turn's reply into the chat. When the engine returns both an
  // acknowledgement and a next question, they render as two separate bubbles
  // with a typing beat between them; probes/asides (question only) render as one.
  // Leaves `loading` true across the gap so the typing indicator bridges it.
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
  // turnId is the same nonce the preceding streaming attempt sent, so the server
  // recognizes this as a retry of that turn rather than a new one (see the
  // comment on streamingTurn).
  const fallbackTurn = useCallback(
    async (
      sessionId: string,
      message: string,
      turnId: string,
      isCancelled?: () => boolean
    ): Promise<boolean> => {
      const data = await apiRequest("/api/barney/message", {
        method: "POST",
        body: { sessionId, message, turnId, language: languageRef.current },
        schema: BarneyMessageResponseSchema,
      });
      await applyTurn(data, isCancelled);
      return data.phaseComplete;
    },
    [applyTurn]
  );

  // Streaming turn — opens the SSE endpoint and reveals the reply as a smooth
  // typewriter. Rather than painting each network delta immediately (which looks
  // choppy because deltas arrive in uneven bursts), incoming text is pushed onto
  // a queue and drained to the visible bubble at a steady cadence, decoupled from
  // network timing. `loading` (the typing indicator) stays on until the first
  // character is actually revealed, bridging model latency. The section/progress/
  // input metadata from the `done` event is applied only once the reveal has
  // fully drained, so the age picker / choice chips don't pop in while Barney is
  // still "typing". If the stream never starts, falls back to fallbackTurn.
  //
  // A single turnId is generated here and reused for both the streaming attempt
  // and its fallback retry. The server may have already fully processed the turn
  // (mutating the stateful InterviewEngine) even though nothing reached this
  // client. Without a shared turnId the retry would resubmit the same answer and
  // the engine would silently process it twice, skipping or misattributing a
  // question; reusing it lets the server return its cached result instead.
  //
  // This only holds while the session lives in the registry. If the api process
  // itself restarted — the `tsx watch` case — the session is gone and the
  // fallback gets `Session not found` rather than a recovered turn. That is the
  // correct answer (the engine state it would replay against no longer exists),
  // but it means a dev-server restart mid-turn surfaces as an error, not a
  // rescue. #502's resume is what covers the user there.
  const streamingTurn = useCallback(
    async (sessionId: string, message: string, isCancelled?: () => boolean): Promise<boolean> => {
      const turnId = randomUUID();
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
              // reaching the reveal is enough to put text on screen — this turn's
              // bubbles open one for it either way, even if no bubble_start ever
              // arrived.
              receivedAny = true;
              reveal.pushText(event.text);
            } else if (event.type === "done") {
              meta.value = {
                section: event.section ?? null,
                progress: event.progress,
                input: event.input,
              };
              phaseComplete = event.phaseComplete;
            } else if (event.type === "error") {
              // The server's own words for why the turn failed (e.g. "AI service
              // temporarily unavailable"). Typed so the catch below knows it is
              // safe to show rather than replacing it with a generic apology.
              //
              // Matched explicitly rather than as a trailing `else`: the day a
              // fifth event type is added (a heartbeat, say), an `else` would
              // abort every turn carrying one with `ServerReportedError(undefined)`.
              // Unknown events are ignored instead.
              throw new ServerReportedError(event.message);
            }
          }
        );
        // Network is done; let the reveal catch up before applying the metadata.
        reveal.end();
        await reveal.drained;
        if (isCancelled?.()) return phaseComplete;
        // Reaching the end of the body says nothing about whether the turn
        // finished. `done` is the server's only statement that it did, and the
        // event parser deliberately skips malformed records rather than
        // throwing — so a truncated body, a dropped connection, a proxy cutting
        // the response, or the api dying mid-turn (in dev, every `tsx watch`
        // restart) all arrive here looking exactly like success: no error, no
        // fallback, no metadata, and a user whose message was posted and whose
        // reply never comes. Treat a missing `done` as the failure it is (#495).
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
        // pending tick keeps revealing the rest of the reply (#487).
        reveal.stop();
        throw err;
      }
    },
    [fallbackTurn]
  );

  // Opens a brand-new conversation on the api and runs its opening turn.
  // `notice`, when given, replaces the transcript with a single system line
  // before the greeting arrives — used when a resumed session turned out to be
  // gone and the user is owed an explanation for the reset.
  const startFreshSession = useCallback(
    async (isCancelled: () => boolean, notice?: string) => {
      const session = await apiRequest("/api/barney/session", {
        method: "POST",
        body: { userId, mode, matchId, language: languageRef.current },
        schema: BarneySessionResponseSchema,
      });
      if (isCancelled()) return;
      setSessionId(session.sessionId);
      setMessages(notice ? [{ role: "system", content: notice }] : []);

      // A completed profile can make the very first ("start") reply already
      // phaseComplete — honour the same transition the send path does, so the
      // user is never stranded on a finished phase.
      const phaseComplete = await streamingTurn(session.sessionId, "start", isCancelled);
      if (!isCancelled() && phaseComplete) {
        completePhase();
      }
    },
    [userId, mode, matchId, streamingTurn, completePhase, setSessionId]
  );

  useEffect(() => {
    if (!userId) return;
    // Captured after the guard so the nested init() sees a non-null string;
    // TypeScript will not carry the narrowing across the function boundary.
    const currentUserId = userId;
    let cancelled = false;
    const isCancelled = () => cancelled;

    async function init() {
      turnActiveRef.current = true;
      setBusy(true);
      setLoading(true);
      try {
        // Resume before creating anything. The api keeps the InterviewEngine's
        // state — collected answers, current question, probe budget — alive for
        // its idle TTL, so a reload only ever lost the client's half: the
        // sessionId that points at it, and the transcript as it was rendered.
        // Without this the mount below unconditionally opened a *new* session
        // and the interview restarted at question one, silently (#496).
        const stored = await loadBarneySession(Date.now());
        if (cancelled) return;
        if (stored && matchesConversation(stored, { userId: currentUserId, mode, matchId })) {
          setSessionId(stored.sessionId);
          setMessages(stored.messages);
          setSection(stored.section);
          setProgress(stored.progress);
          setInput(stored.input);
          // Deliberately no turn is sent. "start" is not a resume command — the
          // engine treats any message after the first as an answer to the
          // current question, so probing the session would consume it.
          return;
        }

        await startFreshSession(isCancelled);
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
      // Release the turn lock for a remount: this cleanup runs before the next
      // init(), and the first turn's finally may not have landed yet.
      turnActiveRef.current = false;
    };
    // startFreshSession is stable for a given user/mode; this effect resumes or
    // starts one session per user/mode.
    // `attempt` is what retryInit bumps to re-run this effect.
  }, [userId, mode, matchId, startFreshSession, attempt, setSessionId]);
  const retryInit = useCallback(() => {
    // Only a failed init is retryable. Guarding here rather than at the call
    // site keeps a stray press from wiping a healthy conversation and starting
    // the interview again from question one.
    if (!initFailed) return;
    setInitFailed(false);
    setMessages([]);
    setSection(null);
    setProgress(undefined);
    setInput(undefined);
    setSessionId(null);
    // `done` and `loading` are deliberately not in this list. `initFailed` can
    // only be set from init()'s catch, which runs after `done` has had no
    // chance to be set and after `loading` is cleared by the same finally — so
    // resetting them here would be dead code. If init ever gains a path that
    // fails with either set, they belong in the list above.
    setAttempt((n) => n + 1);
  }, [initFailed, setSessionId]);

  // Writes the conversation to storage after each completed turn, so a reload,
  // a swipe-away, or the OS killing a backgrounded app can pick it back up.
  // `messages` is in the deps so the effect closes over the finished transcript,
  // but the boundary check makes every mid-reveal run a cheap no-op.
  useEffect(() => {
    if (persistedBoundaryRef.current === turnBoundary) return;
    persistedBoundaryRef.current = turnBoundary;
    if (turnBoundary === 0) return;
    const sessionId = sessionIdRef.current;
    if (!sessionId || !userId || done) return;
    void saveBarneySession({
      sessionId,
      userId,
      mode,
      matchId,
      savedAt: Date.now(),
      messages,
      section,
      progress,
      input,
    });
  }, [turnBoundary, messages, section, progress, input, userId, mode, matchId, done]);

  // A resumed session the api no longer has: it restarted, or the session aged
  // past its idle TTL. Drop the dead snapshot and open a new conversation,
  // saying plainly that the earlier answers could not be recovered — better
  // than a chat that returns "Session not found" to everything typed into it.
  const recoverLostSession = useCallback(async () => {
    await clearBarneySession();
    setSessionId(null);
    setSection(null);
    setProgress(undefined);
    setInput(undefined);
    try {
      await startFreshSession(unmounted, SESSION_LOST_MESSAGE);
    } catch {
      if (unmounted()) return;
      setInitFailed(true);
      setMessages([{ role: "assistant", content: INIT_ERROR_MESSAGE }]);
    }
  }, [startFreshSession, unmounted, setSessionId]);

  // Asks the server whether the phase this session is running has already
  // finished (#511). `phaseComplete` only ever arrives on the stream's `done`
  // event, so a stream that dies after the deltas but before `done` leaves the
  // client believing the turn failed while the api has already persisted the
  // profile and moved the user on. Re-posting cannot recover it — the engine
  // has advanced — so the only honest question left is to ask the server.
  //
  // Fails closed: any error here means we could not confirm completion, and the
  // turn error is shown as before. Claiming a phase finished on a failed lookup
  // would skip someone past an interview they still owe.
  const phaseCompletedOnServer = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    try {
      const state = await apiRequest(`/api/users/${userId}/state`, {
        schema: UserStateResponseSchema,
      });
      return interviewPhaseCompleted(mode, state);
    } catch {
      return false;
    }
  }, [userId, mode]);

  // Resolves true once the turn has been accepted, false if it failed or was
  // refused. The composer uses that to decide whether to put the user's draft
  // back (#510) — before this it cleared unconditionally, so a network drop, a
  // 500 or an expired session silently ate a long answer. Awaited rather than
  // fire-and-forget for exactly that reason.
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const sessionId = sessionIdRef.current;
      // Gated on `busy`, not `loading`: the turn is not over until its reveal has
      // drained, and starting a second turn on top of one still typing is #491.
      // Nothing was sent in that case, so nothing should be discarded either.
      if (!sessionId || turnActiveRef.current || busy || done) return false;
      turnActiveRef.current = true;

      setMessages((prev) => [...prev, { role: "user", content: text }]);
      // Clear the input control until the next turn tells us what to render, so a
      // choice/age control doesn't linger against the wrong question.
      setInput(undefined);
      setBusy(true);
      setLoading(true);

      try {
        const phaseComplete = await streamingTurn(sessionId, text, unmounted);
        if (phaseComplete) {
          completePhase();
        }
        return true;
      } catch (err) {
        if (isSessionLost(err)) {
          await recoverLostSession();
        } else if (await phaseCompletedOnServer()) {
          // The turn that completed the phase is exactly the one whose stream is
          // most likely to be cut short, because it is the longest. The api
          // already persisted the profile and transitioned the user, so move them
          // on rather than stranding them in a finished interview behind an error
          // they cannot act on (#511).
          if (!unmounted()) completePhase();
          // True, not false: the phase really did complete, so the composer must
          // not put the draft back (#510). Restoring it here would leave the
          // Phase 1 answer sitting in the Phase 2 box on the way out.
          return true;
        } else {
          setMessages((prev) => [...prev, { role: "assistant", content: turnErrorMessage(err) }]);
        }
        return false;
      } finally {
        turnActiveRef.current = false;
        setLoading(false);
        setBusy(false);
        // Persist whatever the turn left behind — including a failed turn's
        // error bubble, so a reload does not quietly undo what the user saw.
        setTurnBoundary((n) => n + 1);
      }
    },
    [
      busy,
      done,
      streamingTurn,
      completePhase,
      unmounted,
      recoverLostSession,
      phaseCompletedOnServer,
    ]
  );

  // "Back" control: re-runs the turn with a back command so the engine rewinds to
  // the previous question. Deliberately adds no user bubble — it reads as
  // navigation, not a chat message — and never completes the phase.
  const goBack = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || turnActiveRef.current || busy || done) return;
    turnActiveRef.current = true;
    setInput(undefined);
    setBusy(true);
    setLoading(true);

    void (async () => {
      try {
        await streamingTurn(sessionId, "go back", unmounted);
      } catch (err) {
        if (isSessionLost(err)) {
          await recoverLostSession();
        } else {
          setMessages((prev) => [...prev, { role: "assistant", content: turnErrorMessage(err) }]);
        }
      } finally {
        turnActiveRef.current = false;
        setLoading(false);
        setBusy(false);
        setTurnBoundary((n) => n + 1);
      }
    })();
  }, [busy, done, streamingTurn, unmounted, recoverLostSession]);

  // The language toggle. Holds the same turn lock as send/goBack so a restated
  // question can never interleave with a turn's reveal, but shows no typing
  // indicator: the api answers from the question tree without calling a model.
  //
  // The transcript is replaced by the restated question alone. Keeping the
  // earlier bubbles left the chat half in each language, which in live testing
  // read as a toggle that had not worked; the answers already given are held by
  // the engine, not by what is on screen, so nothing is lost by clearing it.
  const changeLanguage = useCallback(
    async (next: InterviewLanguage) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || turnActiveRef.current || busy || done) return;
      turnActiveRef.current = true;
      setBusy(true);
      try {
        const { turn } = await apiRequest("/api/barney/language", {
          method: "POST",
          body: { sessionId, language: next },
          schema: BarneyLanguageResponseSchema,
        });
        if (!turn || unmounted()) return;
        setMessages([{ role: "assistant", content: turn.question ?? turn.reply }]);
        setSection(turn.section ?? null);
        setProgress(turn.progress);
        setInput(turn.input);
        setTurnBoundary((n) => n + 1);
      } catch {
        // Deliberately silent. The next turn carries the new language, and a
        // lost session is recovered by that turn's own error path.
      } finally {
        turnActiveRef.current = false;
        setBusy(false);
      }
    },
    [busy, done, unmounted]
  );

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  return {
    sessionId: currentSessionId,
    messages,
    loading,
    busy,
    done,
    initFailed,
    section,
    progress,
    input,
    send,
    goBack,
    changeLanguage,
    retryInit,
    appendMessage,
  };
}
