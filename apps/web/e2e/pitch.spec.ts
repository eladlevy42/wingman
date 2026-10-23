import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/53-pitch-chat-ui");

// Registers a fresh user and seeds localStorage so tests start with a valid
// session without going through the register form.
async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `pitch-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Pitch Test",
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
// the component — see barney-phase1.spec.ts for the same pattern.
async function mockPitchBackend(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    let messageCount = 0;
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

      if (/\/api\/users\/.+\/state$/.test(url)) {
        return new Response(
          JSON.stringify({
            matchingState: "MATCHED",
            hasProfile: true,
            matchedWith: "123e4567-e89b-12d3-a456-426614174001",
            matchId: "123e4567-e89b-12d3-a456-426614174002",
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
        return new Response(
          JSON.stringify({
            reply: `Barney's answer number ${messageCount}.`,
            phaseComplete: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (/\/api\/match\/decide$/.test(url)) {
        (window as unknown as { __decideCalls: unknown[] }).__decideCalls.push({
          url,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        return new Response(JSON.stringify({ waiting: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return _fetch(input, init);
    };
    (window as unknown as { __decideCalls: unknown[] }).__decideCalls = [];
  });
}

test("shows genie copy and counter, then the decision screen after 3 questions, then Yeah", async ({
  page,
}) => {
  await mockPitchBackend(page);
  await seedUser(page);
  await page.goto("/pitch");

  // The pitch now opens on the "Introducing…" reveal card (ADR-0022) — tap into
  // the genie chat before the questions.
  await page.getByRole("button", { name: "Send a wish" }).click();

  await expect(
    page.getByText("Just like a genie — you have 3 questions to ask Barney about your match")
  ).toBeVisible();

  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel("3 wishes left")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-pitch-initial-state.png`, fullPage: true });

  const input = page.getByRole("textbox");
  const sendButton = page.getByRole("button", { name: "Send" });

  await input.fill("What do they do for a living?");
  await sendButton.click();
  await expect(page.getByLabel("2 wishes left")).toBeVisible({ timeout: 15_000 });

  await input.fill("What are their hobbies?");
  await sendButton.click();
  await expect(page.getByLabel("1 wish left")).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: `${EVIDENCE}/02-pitch-last-question.png`, fullPage: true });

  await input.fill("Why do you think we're compatible?");
  await sendButton.click();

  // Genie fix (#279): after the 3rd answer the chat is NOT replaced automatically
  // — a "See who it is" button lets the user read Barney's final answer first,
  // then taps through to the reveal.
  const seeWhoItIs = page.getByRole("button", { name: "See who it is" });
  await expect(seeWhoItIs).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Barney's answer number 3.")).toBeVisible();
  await seeWhoItIs.click();

  // The decision screen (design 11) takes over: no more chat input, just the
  // reveal photo and the Neh/Yeah gut call.
  await expect(page.getByText("The Introduction")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("your kind of person?")).toBeVisible();
  const yeahButton = page.getByRole("button", { name: "Yeah" });
  await expect(yeahButton).toBeVisible();
  await expect(page.getByRole("button", { name: "Neh" })).toBeVisible();
  await expect(input).toHaveCount(0);

  await page.screenshot({ path: `${EVIDENCE}/03-pitch-decision-screen.png`, fullPage: true });

  await yeahButton.click();

  await expect(page.getByText("You said yeah.")).toBeVisible({ timeout: 5_000 });

  const decideCalls = await page.evaluate(
    () => (window as unknown as { __decideCalls: unknown[] }).__decideCalls
  );
  expect(decideCalls).toMatchObject([
    { url: expect.stringContaining("/api/match/decide"), body: { decision: "yeah" } },
  ]);

  await page.screenshot({ path: `${EVIDENCE}/04-pitch-pending.png`, fullPage: true });
});

test("unauthenticated user is redirected to /login", async ({ page }) => {
  await page.goto("/pitch");
  await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
  await page.screenshot({ path: `${EVIDENCE}/05-unauthenticated-redirect.png`, fullPage: true });
});
