import { BarneyStreamEventSchema, type BarneyStreamEvent } from "@wingman/shared";

/**
 * Incremental parser for the Barney SSE stream.
 *
 * Split out from the transport (streamBarneyMessage) because the interesting
 * failure modes are all about chunk boundaries, and those are far easier to test
 * as string input than through a live socket: a record split mid-JSON across two
 * network reads, a multi-byte character straddling a chunk, an unparsable
 * record, or an event whose shape no longer matches the shared schema.
 *
 * Records are separated by a blank line; anything after the final separator is
 * held back until its terminator arrives. Malformed records are skipped rather
 * than thrown, so one bad frame cannot abort a reply that is otherwise fine.
 */
export function createBarneyEventParser(onEvent: (event: BarneyStreamEvent) => void): {
  push: (chunk: string) => void;
} {
  let buffer = "";

  return {
    push(chunk: string) {
      buffer += chunk;
      const records = buffer.split("\n\n");
      // The last element is either "" (the chunk ended on a separator) or a
      // partial record — either way it stays buffered.
      buffer = records.pop() ?? "";

      for (const record of records) {
        // A record is a set of `field: value` lines; only the data ones carry
        // the payload, and the spec says to join them with a newline. Checking
        // `record.startsWith("data:")` instead would work against the api as it
        // writes today but silently drop every frame the day a record grows an
        // `event:` or `id:` line above the data — a missed frame that would look
        // exactly like a deliberate skip.
        const json = record
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n");
        if (!json) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          continue;
        }

        const event = BarneyStreamEventSchema.safeParse(parsed);
        if (event.success) onEvent(event.data);
      }
    },
  };
}
