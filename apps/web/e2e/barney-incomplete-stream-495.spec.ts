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
  "../../../docs/evidence/495-mobile-sse-stream-without-done-event-is-treated-as-success"
);

// Copy changed in #510: a failed turn now keeps the user's answer in the
// composer, and the message says so.
const SEND_ERROR_MESSAGE =
  "Something went wrong. Your answer is still in the box — try sending it again.";
const GREETING = "Hey — I'm Barney. Which city do you live in?";
const FALLBACK_REPLY = "Tel Aviv it is. [redacted]";
const TRUNCATED = "Synthetic truncated reply";

/**
 * How the turn that follows the greeting should end.
 *
 * - `empty` — a 200 with no body at all. Nothing rendered, so the client is
 *   free to retry the turn on the non-streaming endpoint.
 * - `truncated` — a `bubble_start` and one `delta`, then the stream just stops.
 *   Content is already on screen, so retrying would double-render it; the turn
 *   has to be reported as failed instead.
 * - `garbage` — an unparsable body. `createBarneyEventParser` skips malformed
 *   records by design, so this behaves exactly like `empty`.
 */
type Ending = "empty" | "truncated" | "garbage";

// Same approach as barney-phase1.spec.ts: page.route does not reliably intercept
// requests through the Vite dev-server proxy, so patch window.fetch directly.
async function mockBarney(page: Page, ending: Ending): Promise<void> {
  await page.addInitScript(
    ({ greeting, fallbackReply, truncated, how }) => {
      const _fetch = window.fetch.bind(window);
      const sse = (events: object[]) =>
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      const json = (body: object, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

        if (/\/api\/barney\/session$/.test(url)) {
          return json({ sessionId: "11111111-1111-1111-1111-111111111111" }, 201);
        }

        const readMessage = () => {
          if (typeof init?.body !== "string") return "";
          try {
            return (JSON.parse(init.body) as { message?: string }).message ?? "";
          } catch {
            return "";
          }
        };

        // The non-streaming fallback. Reaching this at all is the point of the
        // `empty` and `garbage` cases: the turn is retried rather than lost.
        if (/\/api\/barney\/message$/.test(url)) {
          (window as unknown as { __fallbackCalls: number }).__fallbackCalls =
            ((window as unknown as { __fallbackCalls?: number }).__fallbackCalls ?? 0) + 1;
          return json({ reply: fallbackReply, question: fallbackReply, phaseComplete: false });
        }

        if (/\/api\/barney\/message\/stream$/.test(url)) {
          // The init turn always succeeds, so the page settles into a usable
          // chat before the test triggers the incomplete one.
          if (readMessage() === "start") {
            return new Response(
              sse([
                { type: "bubble_start", bubble: "question" },
                { type: "delta", text: greeting },
                { type: "done", phaseComplete: false },
              ]),
              { status: 200, headers: { "Content-Type": "text/event-stream" } }
            );
          }

          // Every branch below is a 200 that never delivers a `done` event.
          const body =
            how === "truncated"
              ? sse([{ type: "bubble_start", bubble: "acknowledgement" }]) +
                `data: {"type":"delta","text":${JSON.stringify(truncated)}}\n\n`
              : how === "garbage"
                ? "data: {{{not json\n\n"
                : "";

          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        return _fetch(input, init);
      };
    },
    { greeting: GREETING, fallbackReply: FALLBACK_REPLY, truncated: TRUNCATED, how: ending }
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
        email: `incomplete-${ts}@example.com`,
        name: "Incomplete Stream Test",
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

async function answerOnce(page: Page, ending: Ending): Promise<void> {
  await mockBarney(page, ending);
  await seedUser(page);
  await page.goto("/barney/phase1");
  await expect(page.getByText(GREETING)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Message input")).toBeEnabled({ timeout: 10_000 });
  await page.getByLabel("Message input").fill("Tel Aviv.");
  await page.getByRole("button", { name: "Send" }).click();
}

const fallbackCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fallbackCalls?: number }).__fallbackCalls ?? 0);

test.describe.configure({ timeout: 90_000 });

test("a stream that ends with no body retries the turn instead of losing it (#495)", async ({
  page,
}) => {
  await answerOnce(page, "empty");

  // Nothing was rendered, so the turn is safe to retry on /message — and it is
  // retried with the same turnId, so the engine returns its cached result
  // rather than processing the answer twice.
  await expect(page.getByText(FALLBACK_REPLY)).toBeVisible({ timeout: 30_000 });
  expect(await fallbackCalls(page)).toBe(1);

  await page.screenshot({ path: `${EVIDENCE}/01-empty-stream-falls-back.png`, fullPage: true });
});

test("a garbage stream body is treated the same as an empty one (#495)", async ({ page }) => {
  await answerOnce(page, "garbage");

  await expect(page.getByText(FALLBACK_REPLY)).toBeVisible({ timeout: 30_000 });
  expect(await fallbackCalls(page)).toBe(1);
});

test("a stream truncated mid-reply reports the failure instead of going quiet (#495)", async ({
  page,
}) => {
  await answerOnce(page, "truncated");

  // Before the fix this was silent: the half-sentence sat there, no error was
  // rendered, and the user's answer was simply gone.
  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeVisible({ timeout: 30_000 });

  // The half that did arrive is kept, in its own bubble, and is not retried —
  // re-sending would render the reply twice.
  await expect(page.getByText(TRUNCATED)).toBeVisible();
  expect(await fallbackCalls(page)).toBe(0);

  await page.screenshot({ path: `${EVIDENCE}/02-truncated-stream-reports-error.png` });
});

test("the chat stays usable after an incomplete stream (#495)", async ({ page }) => {
  await answerOnce(page, "truncated");
  await expect(page.getByText(SEND_ERROR_MESSAGE)).toBeVisible({ timeout: 30_000 });

  // The drain awaiter resolved rather than hanging, so the user can try again.
  const composer = page.getByLabel("Message input");
  await expect(composer).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByRole("status", { name: "Barney is typing" })).toBeHidden();

  // Actually usable, not merely enabled: the answer can be retyped and the Send
  // control comes back with it.
  await composer.fill("Tel Aviv, again.");
  await expect(composer).toHaveValue("Tel Aviv, again.");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  await page.screenshot({ path: `${EVIDENCE}/03-composer-recovers.png`, fullPage: true });
});
