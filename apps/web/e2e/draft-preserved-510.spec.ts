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
  "../../../docs/evidence/510-failed-turn-discards-typed-answer"
);

const SEND_ERROR_MESSAGE =
  "Something went wrong. Your answer is still in the box — try sending it again.";
const GREETING = "Hey — I'm Barney. [redacted]";

// The kind of answer this bug actually cost people: long enough that retyping it
// is a real loss, which is the whole reason #510 is worth fixing.
const LONG_ANSWER =
  "I grew up in a house where nobody ever said what they meant, so I've spent most " +
  "of my twenties learning to just say the thing. It makes me blunt sometimes, but " +
  "I'd rather be the person who says it than the one who lets it rot for six months.";

// Same approach as the other phase-1 specs: page.route does not reliably
// intercept through the Vite dev proxy, so patch window.fetch directly.
// `failTurns` decides whether the non-init turn succeeds or dies.
async function mockPhase1(page: Page, failTurns: boolean): Promise<void> {
  await page.addInitScript(
    ({ greeting, shouldFail }) => {
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

        const isStart = (() => {
          if (typeof init?.body !== "string") return false;
          try {
            return (JSON.parse(init.body) as { message?: string }).message === "start";
          } catch {
            return false;
          }
        })();

        if (/\/api\/barney\/message\/stream$/.test(url)) {
          // The init turn always succeeds, so the page settles into a usable
          // chat before the test exercises the turn under test.
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
          // Fail before anything streams, so the client takes its documented
          // fallback path (re-post via /api/barney/message) rather than the
          // mid-stream branch — a network drop, not a half-delivered reply.
          if (shouldFail) return new Response("upstream is down", { status: 500 });
          return new Response(
            sse([
              { type: "bubble_start", bubble: "question" },
              { type: "delta", text: "Synthetic reply." },
              { type: "done", phaseComplete: false },
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }

        // The non-streaming fallback the client retries on. Failing it too is
        // what makes the turn genuinely lost rather than quietly rescued.
        if (/\/api\/barney\/message$/.test(url) && shouldFail && !isStart) {
          return new Response("upstream is down", { status: 500 });
        }

        return _fetch(input, init);
      };
    },
    { greeting: GREETING, shouldFail: failTurns }
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
        email: `draft-510-${ts}@example.com`,
        name: "Draft Preserved Test",
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

test("a failed turn leaves the typed answer in the composer (#510)", async ({ page }) => {
  await mockPhase1(page, true);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });

  await composer(page).fill(LONG_ANSWER);
  await expect(composer(page)).toHaveValue(LONG_ANSWER);
  await page.screenshot({ path: `${EVIDENCE}/01-answer-typed.png`, fullPage: true });

  await page.getByLabel("Send").click();

  // The turn fails; the error names the loss that no longer happens.
  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeVisible({ timeout: 30_000 });

  // The point of the issue: the answer is still there to send again.
  await expect(composer(page)).toHaveValue(LONG_ANSWER);
  await page.screenshot({
    path: `${EVIDENCE}/02-answer-preserved-after-failure.png`,
    fullPage: true,
  });
});

test("a successful turn still clears the composer immediately (#510)", async ({ page }) => {
  await mockPhase1(page, false);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });

  await composer(page).fill("Twenty-nine, and quietly stubborn about it.");
  await page.getByLabel("Send").click();

  // Cleared optimistically — the composer emptying is what makes sending feel
  // like it worked, and that half must not regress.
  await expect(composer(page)).toHaveValue("", { timeout: 5_000 });
  await expect(page.getByText("Synthetic reply.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(composer(page)).toHaveValue("");
  await page.screenshot({ path: `${EVIDENCE}/03-success-clears-composer.png`, fullPage: true });
});
