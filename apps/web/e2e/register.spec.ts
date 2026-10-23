import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/12-registration-ui-page");

test("shows the sign-up headline with the email form ready to fill", async ({ page }) => {
  await page.goto("/register");

  await expect(page.getByRole("heading", { name: /sign up for wingman/i })).toBeVisible();
  // The form used to sit behind a "Sign up with email" button, because it was
  // one option among three. Email and password is the only way in now (#512),
  // so making someone choose it first would be a click that asks nothing.
  await expect(page.getByRole("button", { name: /sign up with email/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /continue with google/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /continue with microsoft/i })).toHaveCount(0);

  await expect(page.getByLabel("Name")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByLabel("Phone")).toBeVisible();
  await expect(page.getByText("Gender")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-email-form-open.png`, fullPage: true });
});

test("shows validation errors when the email form is submitted empty", async ({ page }) => {
  await page.goto("/register");
  await page.getByRole("button", { name: /get started/i }).click();

  // The password requires at least 8 characters (#277) — its error confirms the
  // form validated client-side and did not navigate away.
  await expect(page.getByText(/at least 8/i)).toBeVisible();
  await expect(page).toHaveURL(/\/register/);

  await page.screenshot({ path: `${EVIDENCE}/03-validation-errors.png`, fullPage: true });
});

test("successful registration stores user in localStorage and redirects", async ({ page }) => {
  const unique = Date.now();
  const email = `test${unique}@example.com`;
  // The email can arrive from the sign-in provider; ?email= stands in for it
  // here and opens the email form pre-filled.
  await page.goto(`/register?email=${encodeURIComponent(email)}`);

  await page.getByLabel("Name").fill("Test User");
  await page.getByLabel("Password").fill("sup3rsecret");
  await page.getByLabel("Phone").fill("+1555000" + (unique % 10000).toString().padStart(4, "0"));
  await page.locator("#gender-male").check();

  await page.screenshot({ path: `${EVIDENCE}/04-form-filled.png`, fullPage: true });

  await page.getByRole("button", { name: /get started/i }).click();

  // After sign-up the user goes to the "Verify Your University" step (#275).
  await expect(page).toHaveURL("/authenticate", { timeout: 15000 });

  const stored = await page.evaluate(() => localStorage.getItem("user"));
  expect(stored).not.toBeNull();
  const user = JSON.parse(stored!);
  expect(user.email).toBe(email);

  await page.screenshot({ path: `${EVIDENCE}/05-after-registration.png`, fullPage: true });
});

test("duplicate email shows server error", async ({ page }) => {
  const email = `dup${Date.now()}@example.com`;

  // Register once
  await page.goto(`/register?email=${encodeURIComponent(email)}`);
  await page.getByLabel("Name").fill("First User");
  await page.getByLabel("Password").fill("sup3rsecret");
  await page.getByLabel("Phone").fill("+15550001234");
  await page.locator("#gender-male").check();
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page).toHaveURL("/authenticate", { timeout: 15000 });

  // Try again with same email
  await page.goto(`/register?email=${encodeURIComponent(email)}`);
  await page.getByLabel("Name").fill("Second User");
  await page.getByLabel("Password").fill("sup3rsecret");
  await page.getByLabel("Phone").fill("+15550001235");
  await page.locator("#gender-male").check();
  await page.getByRole("button", { name: /get started/i }).click();

  await expect(page.getByText(/email already registered/i)).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/06-duplicate-email-error.png`, fullPage: true });
});
