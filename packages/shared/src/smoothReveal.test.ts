import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "./schemas";
import {
  createSmoothReveal,
  createTurnBubbles,
  type SetChatMessages,
  type SmoothRevealCallbacks,
  type SmoothRevealTiming,
} from "./smoothReveal";

const TIMING: SmoothRevealTiming = {
  intervalMs: 18,
  charsPerTick: 2,
  catchupBacklog: 140,
  bubbleBeatMs: 500,
};

/**
 * Stand-in for a client's message list, so a test can assert what the user
 * would actually see rather than how the scheduler got there. Deliberately the
 * same shape as React's functional `setMessages`, because that is what
 * createTurnBubbles is written against.
 */
function makeChat() {
  let messages: ChatMessage[] = [];
  const setMessages: SetChatMessages = (updater) => {
    messages = updater(messages);
  };
  return {
    setMessages,
    messages: () => messages,
    /** Just the assistant bubbles' text, in order. */
    bubbles: () => messages.filter((m) => m.role === "assistant").map((m) => m.content),
    push: (message: ChatMessage) => setMessages((prev) => [...prev, message]),
  };
}

/** One turn's reveal, wired to `chat` exactly the way the clients wire it. */
function makeTurn(
  chat: ReturnType<typeof makeChat>,
  overrides: Partial<SmoothRevealCallbacks> = {}
) {
  let firstRevealCount = 0;
  const callbacks: SmoothRevealCallbacks = {
    ...createTurnBubbles(chat.setMessages),
    onFirstReveal: () => {
      firstRevealCount += 1;
    },
    ...overrides,
  };
  return {
    firstRevealCount: () => firstRevealCount,
    reveal: createSmoothReveal(callbacks, TIMING),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSmoothReveal", () => {
  it("reveals queued text into the bubble at the configured cadence", async () => {
    const chat = makeChat();
    const t = makeTurn(chat);
    t.reveal.pushStart();
    t.reveal.pushText("hello");
    t.reveal.end();

    await vi.runAllTimersAsync();
    await t.reveal.drained;

    expect(chat.bubbles()).toEqual(["hello"]);
    expect(t.firstRevealCount()).toBe(1);
  });

  it("keeps bubble boundaries even when text for both arrives up front", async () => {
    const chat = makeChat();
    const t = makeTurn(chat);
    t.reveal.pushStart();
    t.reveal.pushText("Got it.");
    t.reveal.pushStart();
    t.reveal.pushText("Next question?");
    t.reveal.end();

    await vi.runAllTimersAsync();
    await t.reveal.drained;

    expect(chat.bubbles()).toEqual(["Got it.", "Next question?"]);
    // The beat before a second bubble fires once, not on the first.
    expect(t.firstRevealCount()).toBe(1);
  });

  it("stops revealing when cancelled", async () => {
    const chat = makeChat();
    let cancelled = false;
    const t = makeTurn(chat, { isCancelled: () => cancelled });
    t.reveal.pushStart();
    t.reveal.pushText("a long reply that should not finish");

    await vi.advanceTimersByTimeAsync(TIMING.intervalMs * 3);
    cancelled = true;
    const partial = chat.bubbles().join("");

    await vi.runAllTimersAsync();
    await t.reveal.drained;

    expect(chat.bubbles().join("")).toBe(partial);
  });

  // #487: the reveal loop and the network read are independent schedules. The
  // catch that handles a mid-stream failure ends the read, but a setTimeout(tick)
  // is still in flight — and the reveal used to target whatever bubble was last,
  // which by then is the caller's error bubble.
  describe("mid-stream failure", () => {
    it("reveals nothing more once stopped", async () => {
      const chat = makeChat();
      const t = makeTurn(chat);
      t.reveal.pushStart();
      t.reveal.pushText("...people you actually want to meet?");

      await vi.advanceTimersByTimeAsync(TIMING.intervalMs * 2);
      const revealedBeforeFailure = chat.bubbles().join("");
      expect(revealedBeforeFailure.length).toBeGreaterThan(0);

      // The stream errors; the caller stops the reveal, then renders its error.
      t.reveal.stop();
      const errorBubble = "Something went wrong. Please try again.";
      chat.push({ role: "assistant", content: errorBubble });

      await vi.runAllTimersAsync();

      const bubbles = chat.bubbles();
      expect(bubbles[bubbles.length - 1]).toBe(errorBubble);
      expect(bubbles.join("")).toBe(revealedBeforeFailure + errorBubble);
    });

    it("leaves the partial reply and the error as separate bubbles", async () => {
      const chat = makeChat();
      const t = makeTurn(chat);
      t.reveal.pushStart();
      t.reveal.pushText("Barney was mid-sentence when");

      await vi.advanceTimersByTimeAsync(TIMING.intervalMs * 2);
      t.reveal.stop();
      chat.push({ role: "assistant", content: "Something went wrong. Please try again." });
      await vi.runAllTimersAsync();

      const bubbles = chat.bubbles();
      expect(bubbles).toHaveLength(2);
      expect(bubbles[0]).not.toContain("Something went wrong");
      expect(bubbles[1]).toBe("Something went wrong. Please try again.");
    });

    it("resolves the drain awaiter — no hung promise on the error path", async () => {
      const chat = makeChat();
      const t = makeTurn(chat);
      t.reveal.pushStart();
      t.reveal.pushText("partial");

      await vi.advanceTimersByTimeAsync(TIMING.intervalMs);
      t.reveal.stop();
      await vi.runAllTimersAsync();

      await expect(t.reveal.drained).resolves.toBeUndefined();
    });

    it("resolves the drain awaiter even when no tick is pending", async () => {
      // stop() before anything was ever queued: nothing is scheduled to notice
      // the flag, so stop() has to resolve the promise itself.
      const chat = makeChat();
      const t = makeTurn(chat);
      t.reveal.stop();
      await vi.runAllTimersAsync();

      await expect(t.reveal.drained).resolves.toBeUndefined();
    });

    it("is idempotent — a second stop() does not throw or revive the reveal", async () => {
      const chat = makeChat();
      const t = makeTurn(chat);
      t.reveal.pushStart();
      t.reveal.pushText("partial");
      await vi.advanceTimersByTimeAsync(TIMING.intervalMs);

      t.reveal.stop();
      t.reveal.stop();
      const afterStop = chat.bubbles().join("");
      await vi.runAllTimersAsync();

      expect(chat.bubbles().join("")).toBe(afterStop);
      await expect(t.reveal.drained).resolves.toBeUndefined();
    });

    it("does not touch the error bubble even if the reveal is never stopped", async () => {
      // Belt and braces for #487: stop() is the caller's contract, bubble
      // ownership is the guarantee that holds when a caller forgets it.
      const chat = makeChat();
      const t = makeTurn(chat);
      t.reveal.pushStart();
      t.reveal.pushText("a reply that is still being revealed");
      await vi.advanceTimersByTimeAsync(TIMING.intervalMs * 2);

      chat.push({ role: "assistant", content: "Something went wrong. Please try again." });
      t.reveal.end();
      await vi.runAllTimersAsync();

      const bubbles = chat.bubbles();
      expect(bubbles[bubbles.length - 1]).toBe("Something went wrong. Please try again.");
      expect(bubbles[0]).toBe("a reply that is still being revealed");
    });
  });

  // #491: sending while the previous reply is still being revealed used to
  // interleave the two replies into one bubble, character by character, because
  // both reveal loops wrote to "whatever bubble is last" on their 18 ms ticks.
  describe("a turn that starts while the previous one is still revealing", () => {
    it("keeps the two replies in their own bubbles", async () => {
      const chat = makeChat();
      const greeting = "— I'm Barney. [redacted]";
      const reply = "Synthetic reply about the profile.";

      const first = makeTurn(chat);
      first.reveal.pushStart();
      first.reveal.pushText(greeting);
      first.reveal.end();

      // The composer used to unlock on the first revealed character, so a send
      // could land here — mid-reveal, with the first turn still ticking.
      await vi.advanceTimersByTimeAsync(TIMING.intervalMs * 2);
      expect(chat.bubbles()[0].length).toBeGreaterThan(0);
      expect(greeting.startsWith(chat.bubbles()[0])).toBe(true);

      chat.push({ role: "user", content: "I'm 29." });
      const second = makeTurn(chat);
      second.reveal.pushStart();
      second.reveal.pushText(reply);
      second.reveal.end();

      await vi.runAllTimersAsync();
      await first.reveal.drained;
      await second.reveal.drained;

      expect(chat.bubbles()).toEqual([greeting, reply]);
      expect(chat.messages().map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    });

    it("does not let the older reveal reopen a bubble after the user's message", async () => {
      // The old code's other half: once the user's bubble was last, the stale
      // tick saw a non-assistant bubble and pushed a brand new one — which the
      // incoming turn then revealed into as well.
      const chat = makeChat();
      const first = makeTurn(chat);
      first.reveal.pushStart();
      first.reveal.pushText("first reply, still going");
      first.reveal.end();
      await vi.advanceTimersByTimeAsync(TIMING.intervalMs * 2);

      chat.push({ role: "user", content: "cutting in" });
      await vi.runAllTimersAsync();
      await first.reveal.drained;

      expect(chat.messages().map((m) => m.role)).toEqual(["assistant", "user"]);
      expect(chat.bubbles()).toEqual(["first reply, still going"]);
    });
  });
});

describe("createTurnBubbles", () => {
  it("appends to the bubble it opened, not to whatever is last", () => {
    const chat = makeChat();
    const bubbles = createTurnBubbles(chat.setMessages);

    bubbles.startBubble();
    bubbles.appendToBubble("mine");
    chat.push({ role: "user", content: "interrupting" });
    bubbles.appendToBubble(" still mine");

    expect(chat.messages()).toEqual([
      { role: "assistant", content: "mine still mine" },
      { role: "user", content: "interrupting" },
    ]);
  });

  it("opens a bubble when text arrives before any bubble_start", () => {
    const chat = makeChat();
    const bubbles = createTurnBubbles(chat.setMessages);

    bubbles.appendToBubble("orphan delta");
    bubbles.appendToBubble(" continued");

    expect(chat.bubbles()).toEqual(["orphan delta continued"]);
  });

  it("drops the slice when its bubble is no longer in the list", () => {
    const chat = makeChat();
    const bubbles = createTurnBubbles(chat.setMessages);

    bubbles.startBubble();
    bubbles.appendToBubble("about to be discarded");
    chat.setMessages(() => [{ role: "assistant", content: "a fresh conversation" }]);
    bubbles.appendToBubble(" leaked?");

    expect(chat.bubbles()).toEqual(["a fresh conversation"]);
  });

  it("survives an updater React runs more than once", () => {
    // React may re-run a functional update (StrictMode, a discarded render), so
    // the updater has to be pure — same base list in, same list out.
    let messages: ChatMessage[] = [];
    const setMessages: SetChatMessages = (updater) => {
      const base = messages;
      updater(base);
      messages = updater(base);
    };
    const bubbles = createTurnBubbles(setMessages);

    bubbles.startBubble();
    bubbles.appendToBubble("ab");
    bubbles.appendToBubble("cd");

    expect(messages).toEqual([{ role: "assistant", content: "abcd" }]);
  });
});
