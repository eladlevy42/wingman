import { describe, expect, it } from "vitest";
import type { BarneyStreamEvent } from "@wingman/shared";
import { createBarneyEventParser } from "./sseParser";

function collect(): { events: BarneyStreamEvent[]; push: (chunk: string) => void } {
  const events: BarneyStreamEvent[] = [];
  const parser = createBarneyEventParser((event) => events.push(event));
  return { events, push: parser.push };
}

function record(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe("createBarneyEventParser", () => {
  it("parses a full turn's worth of records", () => {
    const { events, push } = collect();
    push(record({ type: "bubble_start", bubble: "acknowledgement" }));
    push(record({ type: "delta", text: "Got it." }));
    push(record({ type: "done", phaseComplete: false }));

    expect(events).toEqual([
      { type: "bubble_start", bubble: "acknowledgement" },
      { type: "delta", text: "Got it." },
      { type: "done", phaseComplete: false },
    ]);
  });

  it("reassembles a record split across two network reads", () => {
    const { events, push } = collect();
    const full = record({ type: "delta", text: "half and half" });
    const cut = Math.floor(full.length / 2);

    push(full.slice(0, cut));
    expect(events).toHaveLength(0); // nothing emitted until the terminator lands

    push(full.slice(cut));
    expect(events).toEqual([{ type: "delta", text: "half and half" }]);
  });

  it("emits several records that arrive in one chunk", () => {
    const { events, push } = collect();
    push(record({ type: "delta", text: "one" }) + record({ type: "delta", text: "two" }));

    expect(events).toEqual([
      { type: "delta", text: "one" },
      { type: "delta", text: "two" },
    ]);
  });

  it("skips an unparsable record without dropping the ones around it", () => {
    const { events, push } = collect();
    push(record({ type: "delta", text: "before" }));
    push("data: {not json\n\n");
    push(record({ type: "delta", text: "after" }));

    expect(events).toEqual([
      { type: "delta", text: "before" },
      { type: "delta", text: "after" },
    ]);
  });

  it("skips a record that parses but does not match the shared schema", () => {
    const { events, push } = collect();
    push(record({ type: "delta" })); // no text
    push(record({ type: "totally_new_event" }));
    push(record({ type: "delta", text: "kept" }));

    expect(events).toEqual([{ type: "delta", text: "kept" }]);
  });

  it("reads the data field even when other SSE fields precede it", () => {
    // The api writes a bare `data:` record today. If it ever adds an `event:`
    // or `id:` line, the frame must still be read rather than silently dropped.
    const { events, push } = collect();
    push(`event: message\nid: 7\ndata: ${JSON.stringify({ type: "delta", text: "kept" })}\n\n`);

    expect(events).toEqual([{ type: "delta", text: "kept" }]);
  });

  it("joins a payload split across several data lines", () => {
    // SSE says multi-line data fields concatenate with a newline; JSON tolerates
    // the newline, so a large frame split this way still parses.
    const { events, push } = collect();
    push('data: {"type":"delta",\ndata: "text":"split"}\n\n');

    expect(events).toEqual([{ type: "delta", text: "split" }]);
  });

  it("ignores SSE lines that are not data records", () => {
    const { events, push } = collect();
    push(": keep-alive comment\n\n");
    push("event: ping\n\n");
    push(record({ type: "delta", text: "kept" }));

    expect(events).toEqual([{ type: "delta", text: "kept" }]);
  });

  /**
   * #495: the parser skips malformed records rather than throwing, and the
   * transport returns as soon as the reader is done. Between them, an
   * incomplete stream is silent — so the only thing that distinguishes a
   * finished turn from an abandoned one is whether a `done` event arrived.
   * streamingTurn now treats its absence as a failed turn; these pin the
   * premise that absence is what these bodies actually produce.
   */
  describe("a stream that ends without a done event", () => {
    it("emits nothing at all for an empty body", () => {
      const { events, push } = collect();
      push("");

      expect(events).toEqual([]);
    });

    it("emits the partial reply but no done when truncated mid-delta", () => {
      const { events, push } = collect();
      push(record({ type: "bubble_start", bubble: "acknowledgement" }));
      push(record({ type: "delta", text: "Synthetic truncated reply" }));
      // The stream just stops here — no done record ever arrives.

      expect(events).toEqual([
        { type: "bubble_start", bubble: "acknowledgement" },
        { type: "delta", text: "Synthetic truncated reply" },
      ]);
      expect(events.some((event) => event.type === "done")).toBe(false);
    });

    it("emits nothing for a garbage body, exactly as for an empty one", () => {
      const { events, push } = collect();
      push("data: {{{not json\n\n");

      expect(events).toEqual([]);
    });

    it("holds back a done record that was cut off mid-JSON", () => {
      const { events, push } = collect();
      push(record({ type: "bubble_start", bubble: "question" }));
      // The connection dies partway through writing the terminating record.
      push('data: {"type":"done","phaseCom');

      expect(events).toEqual([{ type: "bubble_start", bubble: "question" }]);
    });
  });
});
