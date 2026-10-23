import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/254-pitch-decision-redirect");

// Registers a fresh user and seeds localStorage so tests start with a valid
// session without going through the register form.
async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `pitch-redirect-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Pitch Redirect Test",
        phone,
        gender: "female",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
    const user = await res.json();
    if (!user.id) throw new Error(`seedUser: missing id - ${JSON.stringify(user)}`);
    localStorage.setItem("user", JSON.stringify(user));
  });
}

// Mocks the pitch session flow (session/message/decide/match-photo) plus a
// scripted sequence of matchingState values returned by GET /state calls made
// *after* a decision is recorded — mirrors pitch.spec.ts's and
// waiting.spec.ts's window.fetch patching, since route.fulfill does not
// reliably intercept requests through the Vite dev proxy. Before a decision,
// /state always answers MATCHED (what session init needs); once
// POST /api/match/decide fires, subsequent /state polls step through
// postDecisionStates in order (last entry repeats if polled again).
async function mockPitchBackend(page: Page, postDecisionStates: string[]): Promise<void> {
  await page.addInitScript((postDecisionStates) => {
    const _fetch = window.fetch.bind(window);
    let messageCount = 0;
    let decided = false;
    let pollCall = 0;
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

      if (/\/api\/users\/.+\/state$/.test(url)) {
        const matchingState = decided
          ? postDecisionStates[Math.min(pollCall++, postDecisionStates.length - 1)]
          : "MATCHED";
        return new Response(
          JSON.stringify({
            matchingState,
            hasProfile: true,
            matchedWith: "123e4567-e89b-12d3-a456-426614174001",
            matchId: "123e4567-e89b-12d3-a456-426614174002",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (/\/api\/users\/.+\/match-photo$/.test(url)) {
        return new Response(JSON.stringify({ photoUrl: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "123e4567-e89b-12d3-a456-426614174099" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message$/.test(url)) {
        messageCount += 1;
        return new Response(
          JSON.stringify({
            reply: `Barney's answer number ${messageCount}.`,
            phaseComplete: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (/\/api\/match\/decide$/.test(url)) {
        decided = true;
        return new Response(JSON.stringify({ waiting: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return _fetch(input, init);
    };
  }, postDecisionStates);
}

// Drives the 3-question pitch flow to the Yeah/Neh decision and clicks one.
// Mirrors the canonical flow in pitch.spec.ts after the genie redesign (#279):
// the question counter is a "N wishes left" control, and after the 3rd answer a
// "See who it is" button gates the reveal/decision screen instead of swapping to
// it automatically.
async function goThroughPitchAndDecide(page: Page, decision: "Yeah" | "Neh"): Promise<void> {
  await page.goto("/pitch");

  // The pitch now opens on the "Introducing…" reveal card (ADR-0022) — tap into
  // the genie chat before the questions.
  await page.getByRole("button", { name: "Send a wish" }).click();

  const input = page.getByRole("textbox");
  const sendButton = page.getByRole("button", { name: "Send" });

  await input.fill("What do they do for a living?");
  await sendButton.click();
  await expect(page.getByLabel("2 wishes left")).toBeVisible({ timeout: 15_000 });

  await input.fill("What are their hobbies?");
  await sendButton.click();
  await expect(page.getByLabel("1 wish left")).toBeVisible({ timeout: 15_000 });

  await input.fill("Why do you think we're compatible?");
  await sendButton.click();

  const seeWhoItIs = page.getByRole("button", { name: "See who it is" });
  await expect(seeWhoItIs).toBeVisible({ timeout: 15_000 });
  await seeWhoItIs.click();

  const decisionButton = page.getByRole("button", { name: decision });
  await expect(decisionButton).toBeVisible({ timeout: 15_000 });
  await decisionButton.click();
}

test("redirects to /blind-date once the resolver assigns a date after Yeah (#254)", async ({
  page,
}) => {
  // First post-decision poll (fires immediately on mount) still sees MATCHED
  // — the other side hasn't decided yet — so the "waiting" state is
  // observable before the resolver assigns a date on the next tick. The real
  // poll interval is 60s, so a fake clock is fast-forwarded instead of the
  // test wall clock; clock.install() only fakes timers, not fetch, so the
  // immediate poll above is unaffected by it.
  await mockPitchBackend(page, ["MATCHED", "DATE_ASSIGNED"]);
  await seedUser(page);
  await page.clock.install();

  await goThroughPitchAndDecide(page, "Yeah");
  await expect(page.getByText("You said yeah.")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-decision-recorded-pending.png`, fullPage: true });

  await page.clock.fastForward(60_000);
  await expect(page).toHaveURL("/blind-date", { timeout: 10_000 });

  await page.screenshot({ path: `${EVIDENCE}/02-redirected-to-blind-date.png`, fullPage: true });
});

test("redirects to /waiting when the match is rejected after Yeah (#254)", async ({ page }) => {
  await mockPitchBackend(page, ["MATCHED", "WAITING"]);
  await seedUser(page);
  await page.clock.install();

  await goThroughPitchAndDecide(page, "Yeah");
  await expect(page.getByText("You said yeah.")).toBeVisible();

  await page.clock.fastForward(60_000);
  await expect(page).toHaveURL("/waiting", { timeout: 10_000 });

  await page.screenshot({ path: `${EVIDENCE}/03-redirected-to-waiting.png`, fullPage: true });
});
