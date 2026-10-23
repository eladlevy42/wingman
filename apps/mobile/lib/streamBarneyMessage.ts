import { fetch as expoFetch } from "expo/fetch";
import type { BarneyStreamEvent } from "@wingman/shared";
import type { InterviewLanguage } from "@wingman/shared";
import { apiBaseUrl } from "./apiBaseUrl";
import { createBarneyEventParser } from "./sseParser";

/**
 * Opens the streaming Barney endpoint and invokes onEvent for each server-sent
 * event, mirroring apps/web/src/lib/streamBarneyMessage.ts.
 *
 * The one real difference is the fetch implementation. React Native's built-in
 * fetch is backed by XMLHttpRequest and exposes no `response.body`, so the web
 * version's `res.body.getReader()` is simply not available — the whole reply
 * would arrive at once, which defeats the point. `expo/fetch` is Expo's
 * WinterCG-compliant fetch and does give a real ReadableStream, so the reveal
 * stays incremental on device.
 *
 * Throws if the request itself fails (non-2xx or no body) so the caller can fall
 * back to the plain /message endpoint; a mid-stream failure arrives as an
 * { type: "error" } event instead.
 */
export async function streamBarneyMessage(
  body: { sessionId: string; message: string; turnId: string; language?: InterviewLanguage },
  onEvent: (event: BarneyStreamEvent) => void
): Promise<void> {
  const res = await expoFetch(`${apiBaseUrl()}/api/barney/message/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Stream request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createBarneyEventParser(onEvent);

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // stream: true so a multi-byte character split across two reads is held
    // back rather than decoded into a replacement character.
    parser.push(decoder.decode(value, { stream: true }));
  }
}
