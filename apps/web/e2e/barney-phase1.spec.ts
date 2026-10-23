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
  "../../../docs/evidence/206-barney-phase1-typing-indicator-e2e"
);

// Register a fresh user via the API and seed localStorage so each test starts
// with a valid session without going through the register form each time.
async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `phase1-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Phase1 Test",
        phone,
        gender: "male",
        password: "test-password-123",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Registration failed: ${res.status} - ${text}`);
    }
    const user = await res.json();
    if (!user.id) throw new Error(`seedUser: missing id in response - ${JSON.stringify(user)}`);
    localStorage.setItem("user", JSON.stringify(user));
  });
}

// page.route does not reliably intercept requests that go through the Vite
// dev-server proxy (same issue noted below for the session-init-error test,
// and in blind-date.spec.ts) — it silently never fires, so a delay registered
// via route.continue() never actually applies and the typing indicator's
// visible window becomes whatever the real backend's response time happens
// to be. Patching window.fetch directly guarantees the delay applies.
async function mockSlowMessageReply(page: Page, opts: { skipStart: boolean }): Promise<void> {
  await page.addInitScript((skipStart) => {
    const _fetch = window.fetch.bind(window);
    const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      // Canned session + streamed reply so these tests exercise the typing/loading
      // UI on a deterministic backend, not the real interview engine/model (whose
      // variable latency made them flaky). The delay is what gives the typing
      // indicator a stable, observable window.
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "11111111-1111-1111-1111-111111111111" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
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
        // skipStart delays only the user-sent reply; otherwise delay every turn
        // (including the init "start"), so loading/typing stays visible.
        const delay = skipStart ? !isStart : true;
        if (delay) {
          await new Promise((r) => setTimeout(r, 3_000));
        }
        return new Response(
          sse([
            { type: "bubble_start", bubble: isStart ? "question" : "acknowledgement" },
            {
              type: "delta",
              text: isStart ? "Hey — I'm Barney. [redacted]" : "Got it — good to know.",
            },
            { type: "done", phaseComplete: false },
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return _fetch(input, init);
    };
  }, opts.skipStart);
}

// Only delays the user-triggered message, not the init flow's "start" message.
async function mockSlowUserReply(page: Page): Promise<void> {
  await mockSlowMessageReply(page, { skipStart: true });
}

// Delays every /api/barney/message call, including the init flow's own "start" message.
async function mockSlowInitReply(page: Page): Promise<void> {
  await mockSlowMessageReply(page, { skipStart: false });
}

test("session init fires on mount", async ({ page }) => {
  await seedUser(page);

  // Listen before navigating so the request is never missed.
  const sessionRequest = page.waitForRequest(
    (req) => req.url().includes("/api/barney/session") && req.method() === "POST"
  );

  await page.goto("/barney/phase1");
  await sessionRequest;

  // Wait for Barney's opening line — the typing indicator disappearing alone is
  // not sufficient (it also disappears on error), so assert a message bubble appeared.
  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Barney", { exact: true }).first()).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-session-init-on-mount.png`, fullPage: true });
});

test("user message appears immediately and reply appears after response", async ({ page }) => {
  // Slow the reply so the typing indicator is stable long enough to screenshot.
  // Only the user-triggered message is delayed, not the init flow's own message.
  await mockSlowUserReply(page);

  await seedUser(page);
  await page.goto("/barney/phase1");

  // Wait for Barney's opening message before interacting.
  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible({
    timeout: 30_000,
  });

  await page.getByLabel("Message input").fill("Hello, nice to meet you!");
  await page.getByRole("button", { name: "Send" }).click();

  // User bubble appears immediately — before the reply lands.
  await expect(page.getByText("Hello, nice to meet you!")).toBeVisible();

  // Typing indicator means the reply is still on its way — safe to screenshot now.
  await expect(page.getByRole("status", { name: "Barney is typing" })).toBeVisible({
    timeout: 5_000,
  });
  await page.screenshot({ path: `${EVIDENCE}/02-user-message-sent.png`, fullPage: true });

  // Now wait for the (delayed) reply to land.
  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible({
    timeout: 30_000,
  });

  await page.screenshot({ path: `${EVIDENCE}/03-reply-received.png`, fullPage: true });
});

test("loading indicator shows while in-flight", async ({ page }) => {
  // Delay the init flow's own message call so loading stays visibly true.
  await mockSlowInitReply(page);

  await seedUser(page);
  await page.goto("/barney/phase1");

  // Session completes fast; message is delayed — loading stays true.
  await expect(page.getByRole("status", { name: "Barney is typing" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByLabel("Message input")).toBeDisabled();

  await page.screenshot({ path: `${EVIDENCE}/04-loading-state.png`, fullPage: true });

  // Wait for full init to complete before the test ends.
  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible({
    timeout: 30_000,
  });
});

test("session init error shows error bubble and disables input", async ({ page }) => {
  // route.fulfill does not reliably intercept requests that go through the Vite
  // dev-server proxy. Patching window.fetch directly bypasses CDP routing and
  // guarantees the 500 reaches the component before React renders a reply.
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      // Session succeeds (deterministic, no real backend), but both the streaming
      // endpoint and the /message fallback fail, so the component exhausts both
      // paths and surfaces the init error bubble.
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "11111111-1111-1111-1111-111111111111" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message(\/stream)?$/.test(url)) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return _fetch(input, init);
    };
  });

  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText("Could not start the session. Please refresh the page.")).toBeVisible(
    { timeout: 10_000 }
  );
  await expect(page.getByLabel("Message input")).toBeDisabled();

  await page.screenshot({ path: `${EVIDENCE}/05-session-init-error.png`, fullPage: true });
});

test("unauthenticated user is redirected to /login", async ({ page }) => {
  await page.goto("/barney/phase1");
  await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
  await page.screenshot({ path: `${EVIDENCE}/06-unauthenticated-redirect.png`, fullPage: true });
});

// --- #236: streaming + interactive inputs ------------------------------------

const EVIDENCE_236 = path.resolve(__dirname, "../../../docs/evidence/236-barney-interview-upgrade");

// Builds an SSE response body from a list of events (mirrors the server's
// `data: <json>\n\n` framing).
function toSse(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

// Mocks POST /session and POST /message/stream with canned responses so the new
// UI can be exercised without the interview engine or the model — the streamed
// bytes and the input descriptor fully determine what renders.
async function mockCannedStream(page: Page, streamBody: string): Promise<void> {
  await page.addInitScript((body) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : (input as Request).url;
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "22222222-2222-2222-2222-222222222222" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message\/stream$/.test(url)) {
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return originalFetch(input, init);
    };
  }, streamBody);
}

test("streams the greeting and renders the 18+ age picker with a progress header", async ({
  page,
}) => {
  const stream = toSse([
    { type: "bubble_start", bubble: "acknowledgement" },
    { type: "delta", text: "Hey — I'm Barney. [redacted] " },
    { type: "bubble_start", bubble: "question" },
    { type: "delta", text: "[redacted]" },
    {
      type: "done",
      phaseComplete: false,
      section: { title: "The basics", index: 1, total: 5 },
      progress: { answered: 0, total: 16 },
      input: { kind: "age", min: 18, max: 120 },
    },
  ]);
  await mockCannedStream(page, stream);
  await seedUser(page);
  await page.goto("/barney/phase1");

  // Progress header, question counter (derived from `progress`, not the section), streamed greeting + question.
  await expect(page.getByText("The basics")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("1 / 16")).toBeVisible();
  await expect(page.getByText("[redacted]")).toBeVisible();

  // The age picker cannot offer a value under 18.
  const agePicker = page.getByLabel("Your age");
  await expect(agePicker).toBeVisible();
  await expect(agePicker.locator("option")).toHaveCount(82); // 18..99 inclusive
  await expect(agePicker.locator("option").first()).toHaveText("18");
  await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE_236}/236-05-e2e-age-picker.png`, fullPage: true });
});

test("renders Yes/No/Undecided choice chips with a free-text fallback", async ({ page }) => {
  const stream = toSse([
    { type: "bubble_start", bubble: "question" },
    { type: "delta", text: "Do you want kids?" },
    {
      type: "done",
      phaseComplete: false,
      section: { title: "What matters to you", index: 3, total: 5 },
      progress: { answered: 8, total: 16 },
      input: {
        kind: "choice",
        allowFreeText: true,
        options: [
          { label: "Yes", value: "Yes, I want kids." },
          { label: "No", value: "No, I don't want kids." },
          { label: "Undecided", value: "I'm undecided about kids." },
        ],
      },
    },
  ]);
  await mockCannedStream(page, stream);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText("Do you want kids?")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("What matters to you")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "No" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undecided" })).toBeVisible();
  // Free-text fallback is still offered alongside the chips.
  await expect(page.getByPlaceholder("…or say it in your own words")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE_236}/236-06-e2e-choice-chips.png`, fullPage: true });
});

// --- #228: height is collected via a scrolling picker, never free text -------

const EVIDENCE_228 = path.resolve(
  __dirname,
  "../../../docs/evidence/228-fact-node-extractor-validation"
);

test("renders a scrolling height picker so the value can never be off-topic prose (#228)", async ({
  page,
}) => {
  const stream = toSse([
    { type: "bubble_start", bubble: "question" },
    { type: "delta", text: "And roughly how tall are you?" },
    {
      type: "done",
      phaseComplete: false,
      section: { title: "Looks & style", index: 6, total: 6 },
      progress: { answered: 20, total: 22 },
      input: { kind: "height", minCm: 140, maxCm: 210 },
    },
  ]);
  await mockCannedStream(page, stream);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText("And roughly how tall are you?")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Looks & style")).toBeVisible();

  // The picker is a constrained dropdown — there is no free-text box to type
  // prose into. Each option shows both units, from 140 cm up to 210 cm.
  const heightPicker = page.getByLabel("Your height");
  await expect(heightPicker).toBeVisible();
  await expect(heightPicker.locator("option")).toHaveCount(71); // 140..210 inclusive
  await expect(heightPicker.locator("option").first()).toHaveText("140 cm (4'7\")");
  await expect(heightPicker.locator("option").last()).toHaveText("210 cm (6'11\")");
  await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
  // No free-text message box is offered for this question.
  await expect(page.getByLabel("Message input")).toHaveCount(0);

  await page.screenshot({ path: `${EVIDENCE_228}/228-01-e2e-height-picker.png`, fullPage: true });
});

// --- #418: header counter reflects question progress, not section index -----

const EVIDENCE_418 = path.resolve(
  __dirname,
  "../../../docs/evidence/418-interview-progress-counter"
);

test("header counter reflects question progress out of the phase total, not the section index/total (#418)", async ({
  page,
}) => {
  const stream = toSse([
    { type: "bubble_start", bubble: "question" },
    { type: "delta", text: "What matters most to you in a partner?" },
    {
      type: "done",
      phaseComplete: false,
      // Section 3 of 5, but 9 of 16 questions answered — the counter must read
      // the question progress (10 / 16, since answered ticks up after the
      // question is answered — see AgePicker test's 1 / 16 at answered: 0), not
      // the section position (3 / 5), and must never disagree in direction with
      // the progress bar (also driven by progress.answered / progress.total).
      section: { title: "What matters to you", index: 3, total: 5 },
      progress: { answered: 9, total: 16 },
      input: { kind: "text" },
    },
  ]);
  await mockCannedStream(page, stream);
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText("What matters to you")).toBeVisible({ timeout: 10_000 });
  // Question-based counter, derived from `progress` — not "3 / 5" (section).
  await expect(page.getByText("10 / 16")).toBeVisible();
  await expect(page.getByText("3 / 5")).not.toBeVisible();
  const bar = page.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "56"); // round(9/16 * 100)

  await page.screenshot({
    path: `${EVIDENCE_418}/418-01-question-counter-phase1.png`,
    fullPage: true,
  });
});

test("header counter renders in Phase 2, which has no sections (#418)", async ({ page }) => {
  // Phase 2 (unlike Phase 1) drives its turns through the plain JSON
  // /api/barney/message endpoint, not the SSE /message/stream path — mock that
  // directly rather than reusing mockCannedStream/toSse. See
  // barney-phase2.spec.ts for the same pattern.
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/barney\/message$/.test(url)) {
        return new Response(
          JSON.stringify({
            reply: "How far are you willing to travel for the right person?",
            phaseComplete: false,
            // Phase 2 never sets a section — the counter must still render,
            // keyed off `progress` alone, with the phase's default header title.
            section: null,
            progress: { answered: 2, total: 8 },
            input: { kind: "text" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return _fetch(input, init);
    };
  });
  await seedUser(page);
  await page.goto("/barney/phase2");

  await expect(page.getByText("Getting to know you")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("3 / 8")).toBeVisible();

  await page.screenshot({
    path: `${EVIDENCE_418}/418-02-question-counter-no-section.png`,
    fullPage: true,
  });
});
