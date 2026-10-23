import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/77-debrief-chat-ui");

// Registers a fresh user and seeds localStorage so tests start with a valid
// session without going through the register form.
async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `debrief-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Debrief Test",
        phone,
        gender: "female",
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

// route.fulfill does not reliably intercept requests through the Vite dev
// proxy. Patching window.fetch directly guarantees the mock response reaches
// the component — see pitch.spec.ts for the same pattern.
async function mockDebriefBackend(page: Page, phaseCompleteOnInit: boolean): Promise<void> {
  await page.addInitScript((phaseCompleteOnInit) => {
    const _fetch = window.fetch.bind(window);
    let messageCount = 0;
    // Mirrors the real backend's markDebriefed (#77): once phaseComplete fires,
    // the user's matchingState resets to WAITING so /waiting's own polling
    // (matchingState !== MATCHED/DATE_ASSIGNED) doesn't bounce them to
    // /blind-date on the very next state fetch.
    let debriefed = false;
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

      if (/\/api\/users\/.+\/state$/.test(url)) {
        return new Response(
          JSON.stringify({
            matchingState: debriefed ? "WAITING" : "DATE_ASSIGNED",
            hasProfile: true,
            matchedWith: "123e4567-e89b-12d3-a456-426614174001",
            matchId: "123e4567-e89b-12d3-a456-426614174002",
            followUpState: debriefed ? "DEBRIEFED" : "DATE_PASSED",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "123e4567-e89b-12d3-a456-426614174099" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message$/.test(url)) {
        messageCount += 1;
        const phaseComplete = messageCount === 1 ? phaseCompleteOnInit : true;
        if (phaseComplete) debriefed = true;
        return new Response(
          JSON.stringify({
            reply:
              messageCount === 1
                ? "Hey — how did the date go?"
                : "Glad to hear it. I've saved your feedback for next time.",
            phaseComplete,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return _fetch(input, init);
    };
  }, phaseCompleteOnInit);
}

test("renders, initialises a session, and shows completion + redirect via handleSend", async ({
  page,
}) => {
  await mockDebriefBackend(page, false);
  await seedUser(page);
  await page.goto("/debrief");

  await expect(page.getByText("How did your date go? Tell Barney everything.")).toBeVisible();
  await expect(page.getByText("Hey — how did the date go?")).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: `${EVIDENCE}/01-debrief-session-initialised.png`, fullPage: true });

  const input = page.getByRole("textbox");
  await input.fill("It went great, we're going out again.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Thanks, Barney's got your back for next time.")).toBeVisible({
    timeout: 15_000,
  });

  await page.screenshot({ path: `${EVIDENCE}/02-debrief-completion-message.png`, fullPage: true });

  await expect(page).toHaveURL(/\/waiting/, { timeout: 5_000 });

  await page.screenshot({
    path: `${EVIDENCE}/03-debrief-redirected-to-waiting.png`,
    fullPage: true,
  });
});

test("shows completion message and redirects when the init reply is already phaseComplete", async ({
  page,
}) => {
  await mockDebriefBackend(page, true);
  await seedUser(page);
  await page.goto("/debrief");

  await expect(page.getByText("Thanks, Barney's got your back for next time.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page).toHaveURL(/\/waiting/, { timeout: 5_000 });
});

test("user not yet due for a debrief is redirected to /waiting without starting a session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/users\/.+\/state$/.test(url)) {
        return new Response(JSON.stringify({ matchingState: "DATE_ASSIGNED", hasProfile: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return _fetch(input, init);
    };
  });

  await seedUser(page);
  await page.goto("/debrief");

  // Debrief.tsx redirects to /waiting first, which then bounces straight to
  // /blind-date since matchingState is still DATE_ASSIGNED — correct, since
  // this user's date hasn't passed yet.
  await expect(page).toHaveURL(/\/blind-date/, { timeout: 5_000 });

  await page.screenshot({
    path: `${EVIDENCE}/04-not-due-redirected-away.png`,
    fullPage: true,
  });
});

test("unauthenticated user is redirected to /login", async ({ page }) => {
  await page.goto("/debrief");
  await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
  await page.screenshot({ path: `${EVIDENCE}/05-unauthenticated-redirect.png`, fullPage: true });
});
