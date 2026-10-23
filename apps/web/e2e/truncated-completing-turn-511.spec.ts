import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { pinInterviewLanguage } from "./support/interviewLanguage";

// This spec reads the chat surface's English copy while testing something
// else, so it pins the interview language rather than re-writing every
// selector in Hebrew. See support/interviewLanguage.ts and ADR-0037.
test.beforeEach(async ({ page }) => {
  await pinInterviewLanguage(page);
});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/511-stream-dies-before-done-strands-user"
);

// Must match BarneyPhase1's own SEND_ERROR_MESSAGE. It said "Please try again."
// until #510 rewrote the copy to promise the draft back; the spec was not
// updated with it, so the failing assertion below silently could never match
// and the "is hidden" one passed for the wrong reason.
const SEND_ERROR_MESSAGE =
  "Something went wrong. Your answer is still in the box — try sending it again.";
const GREETING = "Hey — I'm Barney. [redacted]";
const FINAL_REPLY = "That's everything I needed. Give me a second to write this up.";

/**
 * Streams the final turn's deltas and then closes **without** a `done` event —
 * the exact shape of #511. `hasProfile` decides what the server says when the
 * client asks: true means the api really did complete the phase (the stranding
 * case), false means it did not (the turn genuinely failed).
 */
async function mockTruncatedCompletingTurn(page: Page, hasProfile: boolean): Promise<void> {
  await page.addInitScript(
    ({ greeting, finalReply, profileSaved }) => {
      const _fetch = window.fetch.bind(window);
      const sse = (events: object[]) =>
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

        if (/\/api\/users\/.+\/state$/.test(url)) {
          return new Response(
            JSON.stringify({
              matchingState: "IDLE",
              hasProfile: profileSaved,
              universityVerified: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (/\/api\/barney\/session$/.test(url)) {
          return new Response(
            JSON.stringify({ sessionId: "11111111-1111-1111-1111-111111111111" }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }

        const isStart = (() => {
          if (typeof init?.body !== "string") return false;
          try {
            return (JSON.parse(init.body) as { message?: string }).message === "start";
          } catch {
            return false;
          }
        })();

        // Phase 2 posts to the non-streaming endpoint. Answered so that a
        // recovered user actually lands on a working Phase 2 rather than its
        // init-error state — the hand-off is what this test is asserting, and
        // the evidence screenshot should show it arriving somewhere real.
        if (/\/api\/barney\/message$/.test(url)) {
          return new Response(
            JSON.stringify({
              reply: "Now — what are you actually looking for?",
              question: "Now — what are you actually looking for?",
              phaseComplete: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (/\/api\/barney\/message\/stream$/.test(url)) {
          if (isStart) {
            return new Response(
              sse([
                { type: "bubble_start", bubble: "question" },
                { type: "delta", text: greeting },
                { type: "done", phaseComplete: false },
              ]),
              { status: 200, headers: { "Content-Type": "text/event-stream" } }
            );
          }
          // Deltas arrive, then the connection dies. No `done`, so the client
          // never hears `phaseComplete` — and because content already streamed,
          // it will not re-post either.
          return new Response(
            sse([
              { type: "bubble_start", bubble: "acknowledgement" },
              { type: "delta", text: finalReply },
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }

        return _fetch(input, init);
      };
    },
    { greeting: GREETING, finalReply: FINAL_REPLY, profileSaved: hasProfile }
  );
}

async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `truncated-511-${ts}@example.com`,
        name: "Truncated Turn Test",
        phone: `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`,
        gender: "male",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status} - ${await res.text()}`);
    localStorage.setItem("user", JSON.stringify(await res.json()));
  });
}

const composer = (page: Page) => page.getByLabel("Message input");

test("a truncated phase-completing turn moves the user on instead of stranding them (#511)", async ({
  page,
}) => {
  // The api persisted the profile and transitioned the user; only the stream died.
  await mockTruncatedCompletingTurn(page, true);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });
  await composer(page).fill("I want someone who argues with me and then makes me tea.");
  await page.getByLabel("Send").click();

  // The client asks the server, learns the phase is done, and hands off.
  await expect(page.getByText("Moving to Phase 2...")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${EVIDENCE}/01-recovered-moves-on.png`, fullPage: true });

  await expect(page).toHaveURL(/\/barney\/phase2/, { timeout: 10_000 });
  await page.screenshot({ path: `${EVIDENCE}/02-landed-on-phase2.png`, fullPage: true });

  // The dead end #511 describes must not appear.
  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeHidden();
});

test("a truncated turn that did not complete the phase still surfaces the error (#511)", async ({
  page,
}) => {
  // Same truncated stream, but the server says the phase is not finished — the
  // turn really did fail, and claiming otherwise would skip an owed interview.
  await mockTruncatedCompletingTurn(page, false);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });
  await composer(page).fill("Still thinking about it, honestly.");
  await page.getByLabel("Send").click();

  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Moving to Phase 2...")).toBeHidden();
  await expect(page).toHaveURL(/\/barney\/phase1/);
  await page.screenshot({
    path: `${EVIDENCE}/03-genuine-failure-still-errors.png`,
    fullPage: true,
  });
});
