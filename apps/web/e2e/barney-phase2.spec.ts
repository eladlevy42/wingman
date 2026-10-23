import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/29-phase-2-chat-ui");

// Registers a fresh user and seeds localStorage so tests start with a valid
// session without going through the register form.
async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `phase2-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Phase2 Test",
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

test("renders with header and initialises session on mount", async ({ page }) => {
  await seedUser(page);

  // Listen before navigating so the request is never missed.
  const sessionRequest = page.waitForRequest(
    (req) => req.url().includes("/api/barney/session") && req.method() === "POST"
  );

  await page.goto("/barney/phase2");
  await sessionRequest;

  await expect(
    page.getByRole("heading", { name: "Now tell me what you are looking for." })
  ).toBeVisible();

  // Wait for Barney's opening line — the typing indicator disappearing alone is
  // not sufficient (it also disappears on error), so assert a message bubble appeared.
  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Barney", { exact: true }).first()).toBeVisible();

  await page.screenshot({
    path: `${EVIDENCE}/01-phase2-renders-and-session-init.png`,
    fullPage: true,
  });
});

// phaseComplete no longer redirects immediately (#200, docs/adr/0016) — it
// shows a scripted photo request first, and the redirect to /waiting is
// gated behind a successful upload. See barney-phase2-photo.spec.ts for the
// full ask -> preview -> upload -> transition flow.
test("phaseComplete shows the photo request instead of redirecting immediately", async ({
  page,
}) => {
  // route.fulfill does not reliably intercept requests through the Vite dev
  // proxy. Patching window.fetch directly guarantees the mock response reaches
  // the component. See barney-phase1.spec.ts for the same pattern.
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/barney\/message$/.test(url)) {
        return new Response(
          JSON.stringify({
            reply: "Got a clear picture of what you're after — locking that in.",
            phaseComplete: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return _fetch(input, init);
    };
  });

  await seedUser(page);
  await page.goto("/barney/phase2");

  await expect(page.getByText("One more thing before I go match-making")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel("Choose a photo")).toBeAttached();
  await expect(page).not.toHaveURL(/\/waiting/);

  await page.screenshot({
    path: `${EVIDENCE}/02-transition-message-visible.png`,
    fullPage: true,
  });
});

test("unauthenticated user is redirected to /login", async ({ page }) => {
  await page.goto("/barney/phase2");
  await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
  await page.screenshot({ path: `${EVIDENCE}/04-unauthenticated-redirect.png`, fullPage: true });
});
