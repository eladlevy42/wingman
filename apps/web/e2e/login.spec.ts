import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/13-login-ui-page-app-state-routing"
);

// Registers a fresh user through the register form and returns their email. The
// account exists after sign-up (which lands on the "Verify Your University"
// step); the login tests below then exercise logging in with that known email.
async function registerUser(page: import("@playwright/test").Page): Promise<string> {
  const email = `login${Date.now()}@example.com`;
  // The email arrives from the sign-in provider on the real flow; ?email= stands
  // in for it here since the sign-up page no longer has an email field (#275).
  await page.goto(`/register?email=${encodeURIComponent(email)}`);
  await page.getByLabel("Name").fill("Login Test");
  await page.getByLabel("Password").fill("sup3rsecret");
  await page
    .getByLabel("Phone")
    .fill("+1555000" + (Date.now() % 10000).toString().padStart(4, "0"));
  await page.locator("#gender-male").check();
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page).toHaveURL("/authenticate", { timeout: 15000 });
  return email;
}

test("login form renders the email and password fields", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: /log in/i })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-login-initial.png`, fullPage: true });
});

test("unknown email shows an error", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill(`nobody${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("sup3rsecret");
  await page.getByRole("button", { name: /log in/i }).click();

  await expect(page.getByText(/no account found/i)).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-unknown-email-error.png`, fullPage: true });
});

test("known email with the wrong password shows an error", async ({ page }) => {
  const email = await registerUser(page);
  await page.evaluate(() => localStorage.clear());

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: /log in/i }).click();

  await expect(page.getByText(/incorrect email or password/i)).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/04-wrong-password-error.png`, fullPage: true });
});

// Was "redirects to phase 1", and was already failing on main before #512
// touched anything: #329 put university verification ahead of everything else,
// so a freshly registered account lands on /authenticate and cannot reach
// Phase 1 until it is verified. The test had not caught up with the gate.
test("known email with the correct password signs in and resumes onboarding", async ({ page }) => {
  const email = await registerUser(page);

  // Clear the registration session so we exercise login from a clean slate.
  await page.evaluate(() => localStorage.clear());

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("sup3rsecret");
  await page.getByRole("button", { name: /log in/i }).click();

  await expect(page).toHaveURL("/authenticate", { timeout: 15000 });

  const stored = await page.evaluate(() => localStorage.getItem("user"));
  expect(stored).not.toBeNull();
  expect(JSON.parse(stored!).email).toBe(email);

  await page.screenshot({ path: `${EVIDENCE}/03-login-redirect-onboarding.png`, fullPage: true });
});
