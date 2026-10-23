import { BarneyStreamEventSchema, type BarneyStreamEvent } from "@wingman/shared";
import type { InterviewLanguage } from "@wingman/shared";

// Opens the streaming Barney endpoint and parses its server-sent events,
// invoking onEvent for each one. Reads the response body as a stream and splits
// on the SSE record separator ("\n\n"), validating every event at the boundary.
// Throws if the request itself fails (non-2xx or no body) so the caller can fall
// back to the plain /message endpoint; a mid-stream failure arrives as an
// { type: "error" } event instead.
export async function streamBarneyMessage(
  body: { sessionId: string; message: string; turnId: string; language?: InterviewLanguage },
  onEvent: (event: BarneyStreamEvent) => void
): Promise<void> {
  const res = await fetch("/api/barney/message/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Stream request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE records are separated by a blank line; keep any trailing partial
    // record in the buffer until its terminator arrives.
    const records = buffer.split("\n\n");
    buffer = records.pop() ?? "";

    for (const record of records) {
      const line = record.trim();
      if (!line.startsWith("data:")) continue;
      const json = line.slice("data:".length).trim();
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
  }
}
