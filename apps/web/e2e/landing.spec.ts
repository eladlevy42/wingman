import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/238-style-redesign");

test("first page renders the Wingman splash with Get Started", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Wingman")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/03-landing-initial.png`, fullPage: true });
});

test("Get Started leads to the welcome screen with both CTAs", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Get Started" }).click();

  await expect(page).toHaveURL("/welcome");
  await expect(page.getByRole("button", { name: "Sign Up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log In" })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/04-welcome-ctas.png`, fullPage: true });
});

test("Sign Up navigates to registration", async ({ page }) => {
  await page.goto("/welcome");

  await page.getByRole("button", { name: "Sign Up" }).click();

  await expect(page).toHaveURL("/register");

  await page.screenshot({ path: `${EVIDENCE}/05-welcome-signup-navigation.png`, fullPage: true });
});

test("Log In navigates to login", async ({ page }) => {
  await page.goto("/welcome");

  await page.getByRole("button", { name: "Log In" }).click();

  await expect(page).toHaveURL("/login");

  await page.screenshot({ path: `${EVIDENCE}/06-welcome-login-navigation.png`, fullPage: true });
});

test("unknown route redirects to the first page", async ({ page }) => {
  await page.goto("/some-unknown-route");

  await expect(page).toHaveURL("/");
});
