import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/275-restrict-registration-tau-students"
);

// Signs up a fresh user through the register form, which lands on the
// "Verify Your University" step (#275) with the account already in localStorage.
async function signUpToVerify(page: Page): Promise<void> {
  const unique = Date.now();
  // The email arrives from the sign-in provider; ?email= stands in for it since
  // the sign-up page no longer has an email field (#275).
  await page.goto(`/register?email=${encodeURIComponent(`verify${unique}@example.com`)}`);
  await page.getByLabel("Name").fill("Verify Test");
  await page.getByLabel("Password").fill("sup3rsecret");
  await page.getByLabel("Phone").fill("+1555000" + (unique % 10000).toString().padStart(4, "0"));
  await page.locator("#gender-male").check();
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page).toHaveURL("/authenticate", { timeout: 15000 });
}

test("shows the Verify Your University page after sign-up", async ({ page }) => {
  await signUpToVerify(page);

  await expect(page.getByRole("heading", { name: /verify your university/i })).toBeVisible();
  await expect(page.getByText(/reserved for verified university students/i)).toBeVisible();
  await expect(page.getByLabel("University Email")).toBeVisible();
  await expect(page.getByLabel("Student ID Number")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-verify-page.png`, fullPage: true });
});

test("rejects a non-university email with the students-only message (#275)", async ({ page }) => {
  await signUpToVerify(page);

  await page.getByLabel("University Email").fill("someone@gmail.com");
  await page.getByLabel("Student ID Number").fill("20241138");
  await page.getByLabel("Password").fill("sup3rsecret");
  await page.getByRole("button", { name: /verify/i }).click();

  // The client-side schema blocks it: the Tel Aviv University message shows and
  // the page does not advance into the interview.
  await expect(page.getByText(/Tel Aviv University/i)).toBeVisible();
  await expect(page).toHaveURL(/\/authenticate/);

  await page.screenshot({ path: `${EVIDENCE}/02-non-university-rejected.png`, fullPage: true });
});

test("accepts a Tel Aviv University email and continues to the interview", async ({ page }) => {
  await signUpToVerify(page);

  const unique = Date.now();
  await page.getByLabel("University Email").fill(`student${unique}@mail.tau.ac.il`);
  await page.getByLabel("Student ID Number").fill("20241138");
  await page.getByLabel("Password").fill("sup3rsecret");

  await page.screenshot({ path: `${EVIDENCE}/03-verify-filled.png`, fullPage: true });

  await page.getByRole("button", { name: /verify/i }).click();

  // Sign-up leads through the "You're Verified" confirmation and then straight
  // into the interview — the Concierge intro was removed in #327.
  await expect(page).toHaveURL("/verified", { timeout: 15000 });
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page).toHaveURL("/barney/phase1", { timeout: 15000 });

  await page.screenshot({ path: `${EVIDENCE}/04-verified-to-interview.png`, fullPage: true });
});
