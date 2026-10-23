import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/240-completion-waiting-screens");

// Registers a fresh user and seeds localStorage so tests start with a valid
// session without going through the register form.
async function seedUser(page: Page): Promise<string> {
  await page.goto("/login");
  return page.evaluate(async () => {
    const ts = Date.now();
    const email = `completion-waiting-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Completion Waiting Test",
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

// Patches GET /api/users/:id/state so the completion guard sees a scripted
// matchingState instead of hitting the real matching engine — same pattern as
// waiting.spec.ts, since route.fulfill does not reliably intercept requests
// through the Vite dev proxy.
async function mockUserState(page: Page, matchingState: string) {
  await page.addInitScript((matchingState) => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/users\/[^/]+\/state$/.test(url)) {
        return new Response(JSON.stringify({ matchingState, hasProfile: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return _fetch(input, init);
    };
  }, matchingState);
}

test("completion screen shows the You're In. beat and continues to /waiting", async ({ page }) => {
  await mockUserState(page, "WAITING");
  await seedUser(page);
  await page.goto("/completion");

  await expect(page.getByText("You're In.")).toBeVisible();
  await expect(page.getByText("Your profile is ready.")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-completion-screen.png`, fullPage: true });

  await page.getByRole("button", { name: "Enter Wingman" }).click();
  await expect(page).toHaveURL("/waiting");

  await expect(page.getByRole("heading")).toContainText("Findingyour match.");
  await expect(page.getByText("Searching")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-waiting-screen.png`, fullPage: true });
});

test("completion screen redirects to /pitch when matchingState is already MATCHED", async ({
  page,
}) => {
  await mockUserState(page, "MATCHED");
  await seedUser(page);
  await page.goto("/completion");

  await expect(page).toHaveURL("/pitch", { timeout: 5_000 });

  await page.screenshot({ path: `${EVIDENCE}/03-completion-guard-redirects-when-matched.png` });
});
