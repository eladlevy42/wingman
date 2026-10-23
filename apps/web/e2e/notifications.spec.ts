import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/79-msw-setup-notificationservice-interface"
);

test("MSW service worker is registered in dev mode", async ({ page }) => {
  const consoleLogs: string[] = [];
  page.on("console", (msg) => consoleLogs.push(msg.text()));

  await page.goto("/");

  // MSW logs "[MSW] Mocking enabled." when the service worker activates
  await expect
    .poll(() => consoleLogs.some((l) => l.includes("[MSW]")), {
      timeout: 8000,
      message: "Expected MSW to log a startup message in the browser console",
    })
    .toBe(true);

  await page.screenshot({
    path: `${EVIDENCE}/01-msw-enabled.png`,
    fullPage: true,
  });
});

test("MSW intercepts POST /mock/notify and returns 200", async ({ page }) => {
  await page.goto("/");

  // Wait for service worker to be active before sending the request
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
    timeout: 8000,
  });

  const response = await page.evaluate(async () => {
    const res = await fetch("/mock/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "test-user-1",
        type: "MATCH_FOUND",
        payload: { matchId: "test-match-1" },
      }),
    });
    const body = await res.json();
    return { status: res.status, body };
  });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true });

  await page.screenshot({
    path: `${EVIDENCE}/02-notification-intercepted.png`,
    fullPage: true,
  });
});

test("MSW handles all five notification types", async ({ page }) => {
  await page.goto("/");

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
    timeout: 8000,
  });

  const types = [
    "MATCH_FOUND",
    "DATE_ASSIGNED",
    "CHECKIN_PROMPT",
    "PRE_DATE_REMINDER",
    "DEBRIEF_NUDGE",
  ] as const;

  for (const type of types) {
    const result = await page.evaluate(async (t) => {
      const res = await fetch("/mock/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "u-1", type: t, payload: {} }),
      });
      return res.status;
    }, type);

    expect(result).toBe(200);
  }

  await page.screenshot({
    path: `${EVIDENCE}/03-all-types-intercepted.png`,
    fullPage: true,
  });
});
