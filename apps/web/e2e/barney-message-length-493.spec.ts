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
// Mirrored from packages/shared/src/schemas/barney.ts. Playwright's loader does
// not resolve the workspace package's TypeScript sources, and no other spec
// imports from it — so these are literals here.
//
// To be precise about what catches drift: the unit test in that package only
// asserts the ordering invariant (0 < COUNTER_FROM < MAX), so it will not
// notice if the real values change. This spec is the thing that catches it —
// if MAX moves, the counter no longer appears at the character count asserted
// below and these tests fail.
const MAX_MESSAGE_LENGTH = 4000;
const MESSAGE_LENGTH_COUNTER_FROM = MAX_MESSAGE_LENGTH - 200;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/493-mobile-interview-answer-over-4000-chars-fails-with-a-generic-error"
);

// Copy changed in #510: a failed turn now keeps the user's answer in the
// composer, and the message says so.
const SEND_ERROR_MESSAGE =
  "Something went wrong. Your answer is still in the box — try sending it again.";
const GREETING = "Hey — I'm Barney. Which city do you live in?";
const REPLY = "Got it.";

// The server's own bound. Before #493 neither client knew about it, so a longer
// answer was accepted by the composer, rejected with a 400, and reported as a
// generic failure with the typed text already gone.
const OVER_LIMIT = MAX_MESSAGE_LENGTH + 1;

// Same approach as barney-phase1.spec.ts: page.route does not reliably intercept
// requests through the Vite dev-server proxy, so patch window.fetch directly.
// The stream is stubbed so this spec tests the composer's bound, not the engine.
async function mockBarney(page: Page): Promise<void> {
  await page.addInitScript(
    ({ greeting, reply, maxLength }) => {
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

        if (/\/api\/barney\/message(\/stream)?$/.test(url)) {
          let message = "";
          if (typeof init?.body === "string") {
            try {
              message = (JSON.parse(init.body) as { message?: string }).message ?? "";
            } catch {
              message = "";
            }
          }

          // Mirror the real server: anything past the cap is a 400, which is
          // what used to reach the user as "Something went wrong".
          if (message.length > maxLength) {
            return new Response(JSON.stringify({ error: "message too long" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(
            sse([
              { type: "bubble_start", bubble: "question" },
              { type: "delta", text: message === "start" ? greeting : reply },
              { type: "done", phaseComplete: false },
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }

        return _fetch(input, init);
      };
    },
    { greeting: GREETING, reply: REPLY, maxLength: MAX_MESSAGE_LENGTH }
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
        email: `msglength-${ts}@example.com`,
        name: "Message Length Test",
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

async function openInterview(page: Page): Promise<void> {
  await mockBarney(page);
  await seedUser(page);
  await page.goto("/barney/phase1");
  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Message input")).toBeEnabled({ timeout: 10_000 });
}

test.describe.configure({ timeout: 90_000 });

test("the composer will not accept more than the server's limit (#493)", async ({ page }) => {
  await openInterview(page);
  const composer = page.getByLabel("Message input");

  // fill() assigns the value directly and so bypasses maxLength — it is only
  // enforced against editing. Get to one below the cap that way, then type the
  // rest for real, which is the path a user actually takes.
  await composer.fill("a".repeat(MAX_MESSAGE_LENGTH - 1));
  await composer.pressSequentially("bcd");

  await expect(composer).toHaveValue(new RegExp(`^a{${MAX_MESSAGE_LENGTH - 1}}b$`));
  expect(await composer.inputValue()).toHaveLength(MAX_MESSAGE_LENGTH);

  await page.screenshot({ path: `${EVIDENCE}/01-composer-capped-at-limit.png`, fullPage: true });
});

test("the counter appears before the cap and names it at the cap (#493)", async ({ page }) => {
  await openInterview(page);
  const composer = page.getByLabel("Message input");

  // Below the counter threshold there is nothing on screen — the counter is a
  // warning, not permanent furniture.
  await composer.fill("a".repeat(MESSAGE_LENGTH_COUNTER_FROM - 1));
  await expect(page.getByText(`/ ${MAX_MESSAGE_LENGTH}`, { exact: false })).toBeHidden();

  // Nearing the cap: a plain count.
  await composer.fill("a".repeat(MESSAGE_LENGTH_COUNTER_FROM + 50));
  await expect(
    page.getByText(`${MESSAGE_LENGTH_COUNTER_FROM + 50} / ${MAX_MESSAGE_LENGTH}`)
  ).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-counter-nearing-limit.png`, fullPage: true });

  // At the cap: the count is joined by an explanation, so the field refusing
  // further characters is never unexplained.
  await composer.fill("a".repeat(MAX_MESSAGE_LENGTH));
  const atLimit = page.getByText(
    `${MAX_MESSAGE_LENGTH} / ${MAX_MESSAGE_LENGTH} — that's the limit, keep it shorter`
  );
  await expect(atLimit).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/03-counter-at-limit.png`, fullPage: true });
});

test("an answer at exactly the limit still sends (#493)", async ({ page }) => {
  await openInterview(page);
  const composer = page.getByLabel("Message input");

  await composer.fill("a".repeat(MAX_MESSAGE_LENGTH));
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeHidden();

  await page.screenshot({ path: `${EVIDENCE}/04-limit-length-answer-sends.png`, fullPage: true });
});

test("the over-limit answer that used to fail can no longer be composed (#493)", async ({
  page,
}) => {
  await openInterview(page);
  const composer = page.getByLabel("Message input");

  // The exact reproduction from the issue: an answer of MAX_MESSAGE_LENGTH + 1
  // characters. Typed rather than assigned, so the composer's own bound applies.
  await composer.fill("a".repeat(MAX_MESSAGE_LENGTH - 1));
  await composer.pressSequentially("b".repeat(OVER_LIMIT - (MAX_MESSAGE_LENGTH - 1)));

  expect(await composer.inputValue()).toHaveLength(MAX_MESSAGE_LENGTH);

  await page.getByRole("button", { name: "Send" }).click();

  // The turn goes through instead of coming back as a generic failure.
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeHidden();
});
