import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/361-async-find-match-trigger");

async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `waiting-trigger-${ts}@example.com`,
        name: "Trigger Test",
        phone: `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`,
        gender: "female",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
    localStorage.setItem("user", JSON.stringify(await res.json()));
  });
}

// Scripts the async trigger contract (#361): POST /trigger-match answers
// { started } immediately; the page then watches /state and the
// orchestration-status endpoint. `script` controls what the watcher sees:
//   - "exhausted": cycle ends (running:false) with the user still WAITING
//   - "match": the second state poll reports MATCHED
// window.fetch is patched directly — route.fulfill does not reliably
// intercept through the Vite dev proxy (see pitch.spec.ts).
async function mockTriggerBackend(page: Page, script: "exhausted" | "match"): Promise<void> {
  await page.addInitScript((mode) => {
    const _fetch = window.fetch.bind(window);
    // Everything keys off the trigger call, not poll counts — React StrictMode
    // double-runs mount effects in dev, so pre-trigger poll counts are not
    // deterministic.
    let triggered = false;
    let statusChecksAfterTrigger = 0;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/users\/.+\/trigger-match$/.test(url)) {
        triggered = true;
        return json({ started: true }, 202);
      }
      if (/\/api\/match\/orchestration-status$/.test(url)) {
        // The first post-trigger check sees a running cycle (so the progress
        // state is reliably visible); later checks see it finished.
        statusChecksAfterTrigger += 1;
        return json({ running: statusChecksAfterTrigger < 2 });
      }
      if (/\/api\/users\/.+\/state$/.test(url)) {
        const matched = mode === "match" && triggered;
        return json({
          matchingState: matched ? "MATCHED" : "WAITING",
          hasProfile: true,
          universityVerified: true,
        });
      }
      return _fetch(input, init);
    };
  }, script);
}

test("pressing the trigger shows honest progress and the exhausted outcome", async ({ page }) => {
  await mockTriggerBackend(page, "exhausted");
  await seedUser(page);
  await page.goto("/waiting");

  await page.getByRole("button", { name: "Trigger match now" }).click();

  // Progress replaces the button while the background cycle runs.
  await expect(page.getByTestId("search-progress")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/01-negotiating-progress.png`, fullPage: true });

  // The cycle finished with nobody available — the page says so honestly and
  // offers another round, instead of the old fake "No match this time".
  await expect(page.getByTestId("search-exhausted")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Search again" })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/02-exhausted-outcome.png`, fullPage: true });
});

test("a match found during the cycle navigates to /pitch", async ({ page }) => {
  await mockTriggerBackend(page, "match");
  await seedUser(page);
  await page.goto("/waiting");

  await page.getByRole("button", { name: "Trigger match now" }).click();
  await expect(page).toHaveURL(/\/pitch/, { timeout: 15_000 });
  await page.screenshot({ path: `${EVIDENCE}/03-match-found-pitch.png`, fullPage: true });
});
