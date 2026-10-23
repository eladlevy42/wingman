// Smooth-reveal scheduler for a streaming Barney turn, plus the bubble writer
// it drains into.
//
// Network deltas arrive in uneven bursts, so instead of painting each word the
// instant it lands we buffer incoming text and reveal it at our own steady
// cadence — a typewriter effect independent of network jitter.
//
// Lives in `shared` rather than in either client because apps/web and
// apps/mobile run exactly this loop against the same endpoints. They each used
// to carry their own copy, and the drift between them is what let #487 sit
// unfixed on web after mobile was fixed; #491 then turned out to be present in
// both. One implementation, one set of tests.

import type { ChatMessage } from "./schemas";

export interface SmoothRevealTiming {
  /** Tick spacing. */
  intervalMs: number;
  /** Base characters revealed per tick. */
  charsPerTick: number;
  /** Above this backlog, reveal proportionally faster so long replies never lag. */
  catchupBacklog: number;
  /** Pause the reveal inserts before a second/third bubble starts typing. */
  bubbleBeatMs: number;
}

export interface SmoothRevealCallbacks {
  /** Append a slice to the bubble this turn is currently revealing into. */
  appendToBubble: (slice: string) => void;
  /** Open a fresh, empty assistant bubble for this turn. */
  startBubble: () => void;
  /** Fired once, when the very first character is about to be revealed. */
  onFirstReveal: () => void;
  /** Abandon the reveal entirely (e.g. the component unmounted). */
  isCancelled?: () => boolean;
}

export interface SmoothReveal {
  /** Queue a bubble boundary. */
  pushStart: () => void;
  /** Queue text for the current bubble. */
  pushText: (text: string) => void;
  /** No more text is coming; let the reveal drain what it already holds. */
  end: () => void;
  /**
   * Stop revealing now and discard what has not been shown yet. Used when the
   * turn fails after content has already streamed: the caller is about to append
   * an error bubble, and without this the pending tick would concatenate the rest
   * of the reply onto it.
   */
  stop: () => void;
  /** Resolves once the reveal has drained, been stopped, or been cancelled. */
  drained: Promise<void>;
}

export function createSmoothReveal(
  callbacks: SmoothRevealCallbacks,
  timing: SmoothRevealTiming
): SmoothReveal {
  const { appendToBubble, startBubble, onFirstReveal, isCancelled } = callbacks;

  // Ordered reveal queue: "start" opens a fresh bubble, "text" is content to type
  // out. Markers preserve bubble boundaries regardless of arrival timing.
  const queue: Array<{ t: "start" } | { t: "text"; text: string }> = [];
  let ended = false;
  let stopped = false;
  let ticking = false;
  let firstReveal = false;
  let current = ""; // remaining chars of the bubble currently being revealed
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  const tick = () => {
    // `stopped` is checked here and not only at the call sites: a
    // setTimeout(tick) is already in flight when the turn fails, and `ended`
    // alone only means "no more text is coming" — it does not stop the loop.
    if (stopped || isCancelled?.()) {
      ticking = false;
      resolveDrained();
      return;
    }
    // Refill from the queue when the current bubble is fully revealed.
    if (current.length === 0) {
      if (queue.length > 0) {
        const item = queue.shift()!;
        if (item.t === "start") {
          const subsequent = firstReveal;
          if (!firstReveal) {
            firstReveal = true;
            onFirstReveal();
          }
          startBubble();
          // A second/third bubble waits a beat before it starts typing.
          setTimeout(tick, subsequent ? timing.bubbleBeatMs : timing.intervalMs);
          return;
        }
        current += item.text;
      } else {
        if (ended) {
          ticking = false;
          resolveDrained();
          return;
        }
        // Nothing buffered yet — poll until more arrives or the stream ends.
        setTimeout(tick, timing.intervalMs);
        return;
      }
    }
    // Reveal a slice; speed up when the buffer has run far ahead.
    const backlog =
      current.length + queue.reduce((n, item) => n + (item.t === "text" ? item.text.length : 0), 0);
    const take = backlog > timing.catchupBacklog ? Math.ceil(backlog / 40) : timing.charsPerTick;
    appendToBubble(current.slice(0, take));
    current = current.slice(take);
    setTimeout(tick, timing.intervalMs);
  };

  const ensureTicking = () => {
    if (!ticking) {
      ticking = true;
      tick();
    }
  };

  return {
    pushStart: () => {
      queue.push({ t: "start" });
      ensureTicking();
    },
    pushText: (text: string) => {
      queue.push({ t: "text", text });
      ensureTicking();
    },
    end: () => {
      ended = true;
      ensureTicking();
    },
    stop: () => {
      stopped = true;
      ended = true; // unblock any pending drain awaiter
      // A pending tick resolves `drained` on its next run. If none is scheduled,
      // resolve here so the promise can never hang on the error path.
      if (!ticking) resolveDrained();
    },
    drained,
  };
}

/** The functional-update half of React's `useState` setter, framework-free. */
export type SetChatMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;

export interface TurnBubbles {
  /** Open a fresh, empty assistant bubble and take ownership of it. */
  startBubble: () => void;
  /** Append a slice to the owned bubble. A no-op if that bubble is gone. */
  appendToBubble: (slice: string) => void;
}

/**
 * Bubble writer for a single streaming turn.
 *
 * The reveal used to write to `prev[prev.length - 1]` — "whatever bubble is
 * currently last". That made every bug in this area possible: a reveal still
 * ticking when the turn failed wrote into the caller's error bubble (#487), and
 * two reveals ticking at once — turn N still draining when turn N+1 starts —
 * both wrote into the same bubble, weaving the two replies together character
 * by character on their 18 ms ticks (#491).
 *
 * Each turn gets its own writer, which tracks the exact message object it
 * created and only ever replaces that one. Identity rather than an index: the
 * user's own bubble is appended between turns, so indices shift. A writer whose
 * bubble is no longer in the list has nothing to write to and drops the slice,
 * so a stray tick can never reach a bubble it does not own.
 */
export function createTurnBubbles(setMessages: SetChatMessages): TurnBubbles {
  // The message object this writer owns, as it currently sits in the list.
  let owned: ChatMessage | null = null;

  const open = (content: string) => {
    const bubble: ChatMessage = { role: "assistant", content };
    owned = bubble;
    setMessages((prev) => [...prev, bubble]);
  };

  return {
    startBubble: () => open(""),
    appendToBubble: (slice) => {
      const target = owned;
      // A delta before any bubble_start — nothing is open yet, so open one.
      if (!target) {
        open(slice);
        return;
      }
      // `next` and `target` are captured out here, not derived inside the
      // updater, so the updater stays pure: React may run it more than once
      // (StrictMode, a discarded render) and must produce the same list.
      const next: ChatMessage = { role: "assistant", content: target.content + slice };
      owned = next;
      setMessages((prev) => {
        const index = prev.indexOf(target);
        if (index === -1) return prev; // our bubble is gone — drop the slice
        const copy = [...prev];
        copy[index] = next;
        return copy;
      });
    },
  };
}
