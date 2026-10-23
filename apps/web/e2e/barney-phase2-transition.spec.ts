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
  "../../../docs/evidence/23-phase-completion-signal-redirect-to-phase-2-on-saveprofile"
);

// Registers a fresh user and seeds localStorage so tests start with a valid
// session without going through the register form.
async function seedUser(page: Page): Promise<string> {
  await page.goto("/login");
  return page.evaluate(async () => {
    const ts = Date.now();
    const email = `phase2-transition-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Transition Test",
        phone,
        gender: "female",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
    const user = await res.json();
    if (!user.id) throw new Error(`seedUser: missing id — ${JSON.stringify(user)}`);
    localStorage.setItem("user", JSON.stringify(user));
    return user.id as string;
  });
}

test("transition message and redirect fire via the init path when first reply is phaseComplete", async ({
  page,
}) => {
  // route.fulfill does not reliably intercept requests through the Vite dev
  // proxy. Patching window.fetch directly guarantees the mock response reaches
  // the component. Phase 1 streams over /message/stream (#236), so the mock
  // returns an SSE stream whose `done` event carries phaseComplete. See
  // barney-phase1.spec.ts for the same pattern.
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "123e4567-e89b-12d3-a456-426614174099" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message\/stream$/.test(url)) {
        return new Response(
          sse([
            { type: "bubble_start", bubble: "acknowledgement" },
            {
              type: "delta",
              text: "[redacted]",
            },
            { type: "done", phaseComplete: true },
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return _fetch(input, init);
    };
  });

  await seedUser(page);
  await page.goto("/barney/phase1");

  // Transition message must appear before navigation.
  await expect(page.getByText("Moving to Phase 2...")).toBeVisible({ timeout: 15_000 });

  await page.screenshot({
    path: `${EVIDENCE}/01-transition-message-visible.png`,
    fullPage: true,
  });

  // Navigation must follow within 1500 ms delay + test buffer.
  await expect(page).toHaveURL(/\/barney\/phase2/, { timeout: 5_000 });

  await page.screenshot({
    path: `${EVIDENCE}/02-phase2-page-reached.png`,
    fullPage: true,
  });
});

test("transition message and redirect fire via the handleSend path", async ({ page }) => {
  // First stream (init "start") returns phaseComplete: false so the input becomes
  // enabled. The second (user-sent) returns phaseComplete: true. Phase 1 streams
  // over /message/stream (#236), so both are SSE responses.
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    let messageCallCount = 0;
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "123e4567-e89b-12d3-a456-426614174099" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message\/stream$/.test(url)) {
        messageCallCount++;
        const events =
          messageCallCount === 1
            ? [
                { type: "bubble_start", bubble: "question" },
                { type: "delta", text: "Hey — I'm Barney. [redacted]" },
                { type: "done", phaseComplete: false },
              ]
            : [
                { type: "bubble_start", bubble: "acknowledgement" },
                {
                  type: "delta",
                  text: "[redacted]",
                },
                { type: "done", phaseComplete: true },
              ];
        return new Response(sse(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return _fetch(input, init);
    };
  });

  await seedUser(page);
  await page.goto("/barney/phase1");

  // Wait for the init reply so the input is enabled before we send.
  await expect(page.getByLabel("Message input")).toBeEnabled({ timeout: 15_000 });

  await page.getByLabel("Message input").fill("28");
  await page.getByRole("button", { name: "Send" }).click();

  // Transition message must appear before navigation.
  await expect(page.getByText("Moving to Phase 2...")).toBeVisible({ timeout: 15_000 });

  await page.screenshot({
    path: `${EVIDENCE}/03-transition-message-via-handleSend.png`,
    fullPage: true,
  });

  await expect(page).toHaveURL(/\/barney\/phase2/, { timeout: 5_000 });

  await page.screenshot({
    path: `${EVIDENCE}/04-phase2-page-reached-via-handleSend.png`,
    fullPage: true,
  });
});
