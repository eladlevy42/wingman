import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { pinInterviewLanguage } from "./support/interviewLanguage";

// This spec reads the chat surface's English copy while testing something
// else, so it pins the interview language rather than re-writing every
// selector in Hebrew. See support/interviewLanguage.ts and ADR-0037.
test.beforeEach(async ({ page }) => {
  await pinInterviewLanguage(page);
});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/129-apply-wingman-design-system-to-all-existing-pages"
);

// Visual evidence for the design system rollout (#129) — captures the warm
// dark identity on the pages called out in the issue's acceptance criteria.
test("login page shows the warm dark design system", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/login.png`, fullPage: true });
});

test("register page shows the warm dark design system", async ({ page }) => {
  await page.goto("/register");
  // The form used to be collapsed behind the provider buttons (#282); those
  // went with Firebase (#512), so it renders straight away now.
  await expect(page.getByLabel("Name")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/register.png`, fullPage: true });
});

test("barney chat shows the warm dark design system", async ({ page }) => {
  await page.goto("/dev/barney-chat");
  await expect(page.getByLabel("Message input")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/barney-chat.png`, fullPage: true });
});
