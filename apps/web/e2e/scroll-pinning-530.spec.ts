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
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/530-interview-ux-fixes");

// A phone-sized window: the interview is a mobile-first surface, and a wide
// desktop viewport fits the whole conversation with nothing to scroll.
test.use({ viewport: { width: 420, height: 620 } });

const GREETING = "Hey — I'm Barney. [redacted]";

// Long enough that the reveal keeps growing the list for a while after the send,
// which is the exact window in which the old code yanked a reader back down.
const LONG_REPLY = "Synthetic reply. ".repeat(40).trim();

// Same approach as the other phase-1 specs: page.route does not reliably
// intercept through the Vite dev proxy, so patch window.fetch directly.
async function mockPhase1(page: Page): Promise<void> {
  await page.addInitScript(
    ({ greeting, longReply }) => {
      const _fetch = window.fetch.bind(window);
      const sse = (events: object[]) =>
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

        if (url.indexOf("/api/barney/session") !== -1) {
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

        if (url.indexOf("/api/barney/message/stream") !== -1) {
          return new Response(
            sse([
              { type: "bubble_start", bubble: "question" },
              { type: "delta", text: isStart ? greeting : longReply },
              { type: "done", phaseComplete: false },
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }

        return _fetch(input, init);
      };
    },
    { greeting: GREETING, longReply: LONG_REPLY }
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
        email: `scroll-530-${ts}@example.com`,
        name: "Scroll Pinning Test",
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
const scroller = (page: Page) => page.getByTestId("chat-scroll");
const jumpButton = (page: Page) => page.getByRole("button", { name: "Jump to latest" });

// Fills the conversation until the list actually overflows — there is nothing to
// pin or unpin while everything fits on screen.
async function buildScrollableConversation(page: Page): Promise<void> {
  const barneyBubbles = page.getByTestId("barney-bubble");
  for (let i = 0; i < 3; i++) {
    await composer(page).fill(`Answer number ${i + 1}, with enough substance to take up room.`);
    await page.getByLabel("Send").click();
    await expect(composer(page)).toHaveValue("", { timeout: 10_000 });
    // Wait for the reply to finish revealing — the composer stays locked for
    // the whole turn (#491), so the next send would be swallowed otherwise.
    // The closing words only exist once the typewriter has run to the end.
    await expect(barneyBubbles.last()).toContainText("least honest about", { timeout: 30_000 });
  }
  const overflow = await scroller(page).evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(
    overflow.scrollHeight - overflow.clientHeight,
    `the list must overflow for pinning to mean anything, got ${JSON.stringify(overflow)}`
  ).toBeGreaterThan(100);
}

test("scrolling up to re-read is not undone by new content, and jump-to-latest returns (#530)", async ({
  page,
}) => {
  await mockPhase1(page);
  await seedUser(page);
  await page.goto("/barney/phase1");
  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });

  await buildScrollableConversation(page);

  // Following the conversation: no jump button, parked at the bottom.
  await expect(jumpButton(page)).toBeHidden();
  await page.screenshot({ path: `${EVIDENCE}/01-pinned-at-bottom.png`, fullPage: true });

  // Start a fresh turn and scroll up *while the reply is still revealing* —
  // the exact window the bug lived in. Every typewriter tick grows the bubble
  // and re-runs the follow effect, so the old code dragged the reader back down
  // a few times a second and made re-reading impossible.
  const barneyBubbles = page.getByTestId("barney-bubble");
  const repliesBefore = await barneyBubbles.count();
  await composer(page).fill("I sit on it for about a week, if I'm honest.");
  await page.getByLabel("Send").click();
  await expect(barneyBubbles).toHaveCount(repliesBefore + 1, { timeout: 30_000 });

  // Mid-reveal: the bubble exists and is still growing.
  await scroller(page).evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(jumpButton(page)).toBeVisible({ timeout: 5_000 });
  const parkedAt = await scroller(page).evaluate((el) => el.scrollTop);
  await page.screenshot({ path: `${EVIDENCE}/02-scrolled-up-jump-button.png`, fullPage: true });

  // Let the rest of the reply stream in. The reader must not move.
  await expect(barneyBubbles.last()).toContainText("least honest about", { timeout: 30_000 });
  expect(await scroller(page).evaluate((el) => el.scrollTop)).toBe(parkedAt);
  await page.screenshot({ path: `${EVIDENCE}/03-position-held.png`, fullPage: true });

  // Jump to latest is the deliberate way back, and it re-pins.
  await jumpButton(page).click();
  await expect(jumpButton(page)).toBeHidden({ timeout: 5_000 });
  await page.screenshot({ path: `${EVIDENCE}/04-jumped-back-to-latest.png`, fullPage: true });
});

test("answering re-follows the conversation even from scrolled up (#530)", async ({ page }) => {
  await mockPhase1(page);
  await seedUser(page);
  await page.goto("/barney/phase1");
  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });

  await buildScrollableConversation(page);

  await scroller(page).evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(jumpButton(page)).toBeVisible({ timeout: 5_000 });

  // Sending is a deliberate return to the conversation, so the reader is
  // following again without having to press anything.
  await composer(page).fill("Same day, every time — I can't let it sit.");
  await page.getByLabel("Send").click();

  await expect(jumpButton(page)).toBeHidden({ timeout: 10_000 });
  await page.screenshot({ path: `${EVIDENCE}/05-sending-repins.png`, fullPage: true });
});
