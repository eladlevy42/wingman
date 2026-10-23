import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/512-remove-social-and-email-link-sign-in"
);

test("sign-up offers only email and password", async ({ page }) => {
  await page.goto("/register");
  await expect(page.getByLabel("Name")).toBeVisible();
  for (const gone of [/continue with google/i, /continue with microsoft/i, /sign up with email/i]) {
    await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
  }
  await page.screenshot({ path: `${EVIDENCE}/01-register-email-only.png`, fullPage: true });
});

test("sign-in offers only email and password", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  for (const gone of [/continue with google/i, /continue with microsoft/i, /email link/i]) {
    await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
  }
  await page.screenshot({ path: `${EVIDENCE}/02-login-email-only.png`, fullPage: true });
});

test("the removed social-login endpoint is gone", async ({ page }) => {
  // Needs an origin to resolve the relative URL against; the api sits behind
  // the dev server's own origin via Vite's proxy.
  await page.goto("/login");
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/auth/social-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "anything" }),
    });
    return res.status;
  });
  expect(status).toBe(404);
});
