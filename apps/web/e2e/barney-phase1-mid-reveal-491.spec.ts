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
  "../../../docs/evidence/491-sending-mid-reveal-interleaves-two-replies-into-one-bubble"
);

// Both under the reveal's catch-up backlog (140), so they type out at the base
// rate rather than being fast-forwarded.
const GREETING = "Hey — I'm Barney. [redacted]";
const REPLY = "Synthetic reply about the profile.";

// The greeting is streamed in slices with a gap between them, which stretches
// the reveal well past the moment the typing indicator hides. That gap is the
// window #491 lived in: the composer unlocked on the first revealed character,
// so a send could start a second turn while the first was still typing, and
// both reveal loops then wrote to the same bubble on their 18 ms ticks.
const GREETING_SLICES = 6;
const SLICE_GAP_MS = 400;

// Same approach as barney-phase1.spec.ts: page.route does not reliably intercept
// requests through the Vite dev-server proxy, so patch window.fetch directly.
async function mockSlowGreeting(page: Page): Promise<void> {
  await page.addInitScript(
    ({ greeting, reply, slices, gapMs }) => {
      const _fetch = window.fetch.bind(window);
      const sse = (events: object[]) =>
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

        if (/\/api\/barney\/session$/.test(url)) {
          return new Response(
            JSON.stringify({ sessionId: "22222222-2222-2222-2222-222222222222" }),
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

          if (!isStart) {
            return new Response(
              sse([
                { type: "bubble_start", bubble: "question" },
                { type: "delta", text: reply },
                { type: "done", phaseComplete: false },
              ]),
              { status: 200, headers: { "Content-Type": "text/event-stream" } }
            );
          }

          // The greeting dribbles in, so it is still revealing long after the
          // first character lands.
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(sse([{ type: "bubble_start", bubble: "question" }]))
              );
              const size = Math.ceil(greeting.length / slices);
              for (let i = 0; i < greeting.length; i += size) {
                controller.enqueue(
                  encoder.encode(sse([{ type: "delta", text: greeting.slice(i, i + size) }]))
                );
                await new Promise((r) => setTimeout(r, gapMs));
              }
              controller.enqueue(encoder.encode(sse([{ type: "done", phaseComplete: false }])));
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
    { greeting: GREETING, reply: REPLY, slices: GREETING_SLICES, gapMs: SLICE_GAP_MS }
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
        email: `midreveal-${ts}@example.com`,
        name: "Mid Reveal Test",
        phone: `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`,
        gender: "male",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status} - ${await res.text()}`);
    localStorage.setItem("user", JSON.stringify(await res.json()));
  });
}

// Barney's bubbles. `data-testid` rather than the Tailwind classes: a restyle
// would make a class selector return nothing and the interleaving assertions
// below would pass vacuously.
const barneyBubbles = (page: Page) => page.getByTestId("barney-bubble");

/**
 * Samples the composer on every animation frame and keeps every observation
 * made while Barney's first bubble was mid-reveal. The single-instant check in
 * the first test proves the composer is locked at one moment; this proves it
 * was never unlocked at any moment of the reveal, which is the actual invariant
 * and the one a poll can otherwise step straight over.
 */
async function recordComposerDuringReveal(page: Page, fullText: string): Promise<void> {
  await page.addInitScript((expected: string) => {
    const samples: Array<{ length: number; enabled: boolean }> = [];
    (window as unknown as { __midRevealSamples: typeof samples }).__midRevealSamples = samples;

    const poll = () => {
      const bubble = document.querySelector('[data-testid="barney-bubble"]');
      const composer = document.querySelector<HTMLInputElement>(
        'input[aria-label="Message input"]'
      );
      const text = bubble?.textContent ?? "";
      // Only the reveal window counts: before the first character there is
      // nothing on screen, and once the bubble is complete the composer is
      // supposed to unlock.
      if (bubble && composer && text.length > 0 && text.length < expected.length) {
        samples.push({ length: text.length, enabled: !composer.disabled });
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }, fullText);
}

async function midRevealSamples(page: Page): Promise<Array<{ length: number; enabled: boolean }>> {
  return page.evaluate(
    () =>
      (window as unknown as { __midRevealSamples: Array<{ length: number; enabled: boolean }> })
        .__midRevealSamples
  );
}

/** Resolves once the first bubble has text but is not yet the whole greeting. */
async function waitForPartialGreeting(page: Page): Promise<string> {
  const bubble = barneyBubbles(page).first();
  await expect(bubble).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await bubble.innerText()).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const partial = await bubble.innerText();
  expect(partial.length).toBeLessThan(GREETING.length);
  expect(GREETING.startsWith(partial)).toBe(true);
  return partial;
}

test("the composer stays locked while Barney is still revealing (#491)", async ({ page }) => {
  // Registration against the real API plus a deliberately slow greeting stream
  // puts this close to the default 30s budget on a cold dev server.
  test.slow();
  await mockSlowGreeting(page);
  await recordComposerDuringReveal(page, GREETING);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await waitForPartialGreeting(page);

  // The typing indicator has handed over to the bubble — but the turn is not
  // over, so nothing can be sent into the middle of it.
  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible();
  await expect(page.getByLabel("Message input")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await page.screenshot({
    path: `${EVIDENCE}/01-composer-locked-mid-reveal.png`,
    fullPage: true,
  });

  // Once the reveal drains, the composer comes back and the greeting is intact.
  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Message input")).toBeEnabled({ timeout: 30_000 });
  expect(await barneyBubbles(page).allInnerTexts()).toEqual([GREETING]);

  await page.screenshot({
    path: `${EVIDENCE}/02-composer-unlocked-after-reveal.png`,
    fullPage: true,
  });

  // The whole reveal window, not just the instant asserted above: the composer
  // must have been disabled in every frame where the bubble was partially
  // revealed. The count guard stops an empty sample set passing vacuously.
  const samples = await midRevealSamples(page);
  expect(samples.length).toBeGreaterThan(5);
  expect(samples.filter((s) => s.enabled)).toEqual([]);
});

test("consecutive replies stay in their own bubbles, uninterleaved (#491)", async ({ page }) => {
  // Registration against the real API plus a deliberately slow greeting stream
  // puts this close to the default 30s budget on a cold dev server.
  test.slow();
  await mockSlowGreeting(page);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Message input")).toBeEnabled({ timeout: 30_000 });

  await page.getByLabel("Message input").fill("I'm 29.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(REPLY)).toBeVisible({ timeout: 30_000 });
  // Let any stray tick from the first turn fire. Before the fix this is the
  // window in which the two replies wove themselves together.
  await page.waitForTimeout(1_500);

  const texts = await barneyBubbles(page).allInnerTexts();
  expect(texts).toEqual([GREETING, REPLY]);
  // Neither bubble carries a fragment of the other — the interleaving signature.
  expect(texts[0]).not.toContain("Got it");
  expect(texts[1]).not.toContain("Barney");

  await page.screenshot({ path: `${EVIDENCE}/03-separate-bubbles.png`, fullPage: true });
});
