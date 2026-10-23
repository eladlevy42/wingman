import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/205-notification-banner-e2e-fix-missing-seeduser"
);
const EVIDENCE_306 = path.resolve(
  __dirname,
  "../../../docs/evidence/306-date-assigned-notification-type"
);

// Registers a fresh user and seeds localStorage so /waiting doesn't redirect
// to /login — mirrors the seedUser pattern in blind-date.spec.ts.
async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `notification-banner-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Notification Banner Test",
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

// navigator.serviceWorker.controller !== null only proves the Service Worker
// controls the page — it does not prove MSW's internal message-passing bridge
// (the postMessage round-trip between the SW and this page's msw/browser
// client that actually dispatches to registered handlers) is wired up yet.
// Losing that race makes /mock/notify respond with an empty body instead of
// running its handler. Poll a stateless GET /mock/ping probe — which shares
// the exact same dispatch path — until it actually round-trips correctly.
async function waitForMSW(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
    timeout: 8000,
  });

  await expect(async () => {
    const res = await page.evaluate(async () => {
      const r = await fetch("/mock/ping");
      return { status: r.status, body: (await r.json()) as unknown };
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
  }).toPass({ timeout: 8000 });
}

async function sendNotification(page: Page, type: string, payload: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ type, payload }) => {
      await fetch("/mock/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "test-user", type, payload }),
      });
    },
    { type, payload }
  );
}

test("banner appears on /waiting when a notification arrives", async ({ page }) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "MATCH_FOUND", { matchId: "m-1" });

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("You've got a match!");

  await page.screenshot({
    path: `${EVIDENCE}/01-banner-appears.png`,
    fullPage: true,
  });
});

test("badge count increments when notification arrives", async ({ page }) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "CHECKIN_PROMPT");

  const badge = page.getByLabel("1 unread notification");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("1");

  await page.screenshot({
    path: `${EVIDENCE}/02-badge-count.png`,
    fullPage: true,
  });
});

test("X button dismisses the banner without changing the badge", async ({ page }) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "PRE_DATE_REMINDER");

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();

  await page.getByLabel("Dismiss notification").click();
  await expect(banner).not.toBeVisible();

  // Badge count stays at 1 because auto-dismiss doesn't count as a click
  const badge = page.getByLabel("1 unread notification");
  await expect(badge).toBeVisible();

  await page.screenshot({
    path: `${EVIDENCE}/03-banner-dismissed.png`,
    fullPage: true,
  });
});

test("clicking MATCH_FOUND banner navigates to /pitch and decrements badge", async ({ page }) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "MATCH_FOUND", { matchId: "m-2" });

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();

  await banner.getByRole("button", { name: /match/i }).click();

  await expect(page).toHaveURL("/pitch");

  // Badge count goes to 0 after click — badge disappears
  const badge = page.getByLabel(/unread notification/);
  await expect(badge).not.toBeVisible();

  await page.screenshot({
    path: `${EVIDENCE}/04-click-navigates-to-pitch.png`,
    fullPage: true,
  });
});

test("clicking DATE_ASSIGNED banner navigates to /blind-date and decrements badge (#306)", async ({
  page,
}) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "DATE_ASSIGNED", { matchId: "m-4", venue: "Aroma Coffee" });

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Your date is set");

  await banner.getByRole("button", { name: /date is set/i }).click();

  await expect(page).toHaveURL("/blind-date");

  // Badge count goes to 0 after click — badge disappears
  const badge = page.getByLabel(/unread notification/);
  await expect(badge).not.toBeVisible();

  await page.screenshot({
    path: `${EVIDENCE_306}/01-date-assigned-banner-navigates-to-blind-date.png`,
    fullPage: true,
  });
});

test("multiple notifications show one at a time in queue order", async ({ page }) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "MATCH_FOUND", { matchId: "m-3" });
  await sendNotification(page, "CHECKIN_PROMPT");

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("You've got a match!");

  await page.screenshot({
    path: `${EVIDENCE}/05-queue-first-notification.png`,
    fullPage: true,
  });

  // Dismiss first banner manually
  await page.getByLabel("Dismiss notification").click();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Barney wants to check in");

  await page.screenshot({
    path: `${EVIDENCE}/06-queue-second-notification.png`,
    fullPage: true,
  });
});

test("banner auto-dismisses after 5 seconds", async ({ page }) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "DEBRIEF_NUDGE");

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Time to debrief");

  await page.screenshot({
    path: `${EVIDENCE}/07-banner-before-auto-dismiss.png`,
    fullPage: true,
  });

  await expect(banner).not.toBeVisible({ timeout: 7000 });

  await page.screenshot({
    path: `${EVIDENCE}/08-banner-after-auto-dismiss.png`,
    fullPage: true,
  });
});
