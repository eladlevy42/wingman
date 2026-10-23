import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/224-appnav-notification-history");

async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `notification-history-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Notification History Test",
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

test("Notifications control is keyboard-focusable and opens the notification history", async ({
  page,
}) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "MATCH_FOUND", { matchId: "m-1" });

  const trigger = page.getByRole("button", { name: "Notifications" });
  await expect(trigger).toBeVisible();

  await trigger.focus();
  await expect(trigger).toBeFocused();

  await page.screenshot({
    path: `${EVIDENCE}/01-trigger-focused.png`,
    fullPage: true,
  });

  await trigger.click();

  const menu = page.getByRole("menu", { name: "Notifications" });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("You've got a match!");
  await expect(menu).toHaveCSS("opacity", "1");

  await page.screenshot({
    path: `${EVIDENCE}/02-menu-open.png`,
    fullPage: true,
  });
});

test("opening the notification history clears the unread badge", async ({ page }) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  await sendNotification(page, "CHECKIN_PROMPT");

  const badge = page.getByLabel("1 unread notification");
  await expect(badge).toBeVisible();

  const trigger = page.getByRole("button", { name: "Notifications" });
  await trigger.click();

  await expect(page.getByLabel(/unread notification/)).not.toBeVisible();

  await page.screenshot({
    path: `${EVIDENCE}/03-badge-cleared.png`,
    fullPage: true,
  });
});

test("notification history shows an empty state when there is no history", async ({ page }) => {
  await seedUser(page);
  await page.goto("/waiting");
  await waitForMSW(page);

  const trigger = page.getByRole("button", { name: "Notifications" });
  await trigger.click();

  const menu = page.getByRole("menu", { name: "Notifications" });
  await expect(menu).toContainText("No notifications yet.");
  await expect(menu).toHaveCSS("opacity", "1");

  await page.screenshot({
    path: `${EVIDENCE}/04-empty-state.png`,
    fullPage: true,
  });
});
