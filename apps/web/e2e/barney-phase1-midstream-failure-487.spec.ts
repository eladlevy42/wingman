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
  "../../../docs/evidence/487-web-phase-1-mid-stream-failure-interleaves-buffered-reply-into-the-error-bubble"
);

// Copy changed in #510: a failed turn now keeps the user's answer in the
// composer, and the message says so.
const SEND_ERROR_MESSAGE =
  "Something went wrong. Your answer is still in the box — try sending it again.";
const GREETING = "Hey — I'm Barney. [redacted]";

// Long enough that the smooth reveal (2 chars / 18ms) is still mid-bubble when
// the stream dies, which is the only condition under which #487 shows up.
const REPLY = "Synthetic reply. ".repeat(8).trim();

// The failure has to land *after* some text has been revealed, so the error
// record is enqueued in a second chunk rather than alongside the delta — a real
// mid-stream death, not a stream that was born broken.
const FAILURE_DELAY_MS = 400;

// Same approach as barney-phase1.spec.ts: page.route does not reliably intercept
// requests through the Vite dev-server proxy, so patch window.fetch directly.
async function mockMidStreamFailure(page: Page): Promise<void> {
  await page.addInitScript(
    ({ reply, delayMs, greeting }) => {
      const _fetch = window.fetch.bind(window);
      const sse = (events: object[]) =>
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

        if (/\/api\/barney\/session$/.test(url)) {
          return new Response(
            JSON.stringify({ sessionId: "11111111-1111-1111-1111-111111111111" }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }

        if (/\/api\/barney\/message\/stream$/.test(url)) {
          let isStart = false;
          if (typeof init?.body === "string") {
            try {
              isStart = (JSON.parse(init.body) as { message?: string }).message === "start";
            } catch {
              isStart = false;
            }
          }

          // The init turn succeeds normally so the page settles into a usable
          // chat before the test triggers the failing turn.
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

          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  sse([
                    { type: "bubble_start", bubble: "acknowledgement" },
                    { type: "delta", text: reply },
                  ])
                )
              );
              // Let the reveal get partway through the bubble, then kill the turn.
              await new Promise((r) => setTimeout(r, delayMs));
              controller.enqueue(
                encoder.encode(sse([{ type: "error", message: "upstream connection lost" }]))
              );
              controller.close();
            },
          });

          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        return _fetch(input, init);
      };
    },
    { reply: REPLY, delayMs: FAILURE_DELAY_MS, greeting: GREETING }
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
        email: `midstream-${ts}@example.com`,
        name: "Midstream Test",
        phone: `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`,
        gender: "male",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status} - ${await res.text()}`);
    const user = await res.json();
    localStorage.setItem("user", JSON.stringify(user));
  });
}

// Barney's bubbles, excluding the typing indicator (which carries role="status").
const barneyBubbles = (page: Page) => page.locator("div.rounded-tl-lg.bg-accent:not([role])");

test("a mid-stream failure keeps the partial reply and the error in separate bubbles (#487)", async ({
  page,
}) => {
  await mockMidStreamFailure(page);
  await seedUser(page);
  await page.goto("/barney/phase1");

  // Wait for the greeting to finish *revealing*, not merely to start: the typing
  // indicator hides on the first character, and sending while the previous reveal
  // is still ticking is a different race (see Notes on the PR).
  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Message input").fill("I'm 29.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeVisible({ timeout: 30_000 });

  // Give any stray reveal tick time to fire. Before the fix, this is the window
  // in which the rest of REPLY got concatenated onto the error bubble.
  await page.waitForTimeout(1_500);

  const errorBubble = page.getByText(SEND_ERROR_MESSAGE);
  await expect(errorBubble).toHaveText(SEND_ERROR_MESSAGE);

  // The error bubble is its own bubble, and nothing from Barney's reply leaked in.
  const bubbles = barneyBubbles(page);
  const texts = await bubbles.allInnerTexts();
  const last = texts[texts.length - 1];
  expect(last).toBe(SEND_ERROR_MESSAGE);
  expect(last).not.toContain("you actually want to meet");

  // Whatever was revealed before the failure stayed in its own bubble, and it is
  // a prefix of the reply rather than a fragment of it mixed with anything else.
  const partial = texts[texts.length - 2] ?? "";
  expect(partial).not.toContain(SEND_ERROR_MESSAGE);
  expect(partial.length).toBeGreaterThan(0);
  expect(REPLY.startsWith(partial)).toBe(true);

  await page.screenshot({
    path: `${EVIDENCE}/01-midstream-failure-separate-bubbles.png`,
    fullPage: true,
  });
});

test("the chat stays usable after a mid-stream failure (#487)", async ({ page }) => {
  await mockMidStreamFailure(page);
  await seedUser(page);
  await page.goto("/barney/phase1");

  // Wait for the greeting to finish *revealing*, not merely to start: the typing
  // indicator hides on the first character, and sending while the previous reveal
  // is still ticking is a different race (see Notes on the PR).
  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Message input").fill("I'm 29.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeVisible({ timeout: 30_000 });

  // The drain awaiter resolved rather than hanging, so the composer is live again.
  await expect(page.getByLabel("Message input")).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-composer-recovers.png`, fullPage: true });
});
