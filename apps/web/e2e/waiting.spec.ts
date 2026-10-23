import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/48-waiting-screen-ui-locked-screen-with-polling"
);

// Registers a fresh user and seeds localStorage so tests start with a valid
// session without going through the register form.
async function seedUser(page: Page): Promise<string> {
  await page.goto("/login");
  return page.evaluate(async () => {
    const ts = Date.now();
    const email = `waiting-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Waiting Test",
        phone,
        gender: "female",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
    const user = await res.json();
    if (!user.id) throw new Error(`seedUser: missing id — ${JSON.stringify(user)}`);
    localStorage.setItem("user", JSON.stringify(user));
    return user.id as string;
  });
}

// Patches window.fetch so GET /api/users/:id/state resolves to a scripted
// sequence of matchingState values instead of hitting the real matching
// engine — mirrors the pattern in barney-phase2-transition.spec.ts, since
// route.fulfill does not reliably intercept requests through the Vite dev
// proxy.
async function mockUserState(page: Page, states: string[]) {
  await page.addInitScript((states) => {
    const _fetch = window.fetch.bind(window);
    let call = 0;
    (window as unknown as { __stateCallCount: number }).__stateCallCount = 0;
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/users\/[^/]+\/state$/.test(url)) {
        (window as unknown as { __stateCallCount: number }).__stateCallCount++;
        const matchingState = states[Math.min(call, states.length - 1)];
        call++;
        return new Response(JSON.stringify({ matchingState, hasProfile: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return _fetch(input, init);
    };
  }, states);
}

test("waiting screen renders the locked layout with no navigation links", async ({ page }) => {
  await mockUserState(page, ["WAITING"]);
  await seedUser(page);
  await page.goto("/waiting");

  await expect(page.getByRole("heading")).toContainText("Findingyour match.");
  await expect(
    page.getByText(
      "Wingman is reviewing the community to introduce you thoughtfully. You'll be notified when there's a match worth your time."
    )
  ).toBeVisible();
  await expect(page.getByText("Searching")).toBeVisible();
  await expect(page.getByRole("link")).toHaveCount(0);

  await page.screenshot({ path: `${EVIDENCE}/01-waiting-locked-screen.png`, fullPage: true });
});

test("polls at the configured interval", async ({ page }) => {
  await mockUserState(page, ["WAITING"]);
  await seedUser(page);
  // The real interval is 60s (MATCH_COOLDOWN_MINUTES * MS_PER_MINUTE, with
  // MATCH_COOLDOWN_MINUTES = 1) — too long to wait on in real time, so we
  // install a fake clock and fast-forward it instead of the test wall clock.
  await page.clock.install();
  await page.goto("/waiting");

  const getCallCount = () =>
    page.evaluate(() => (window as unknown as { __stateCallCount: number }).__stateCallCount);

  // React StrictMode (main.tsx) double-invokes effects on mount in dev, so the
  // poll can fire more than once before settling — wait for the count to
  // stabilize instead of asserting an exact value.
  await expect.poll(getCallCount).toBeGreaterThanOrEqual(1);
  const baseline = await getCallCount();

  // A further poll fires once the interval elapses.
  await page.clock.fastForward(60_000);
  await expect.poll(getCallCount).toBeGreaterThan(baseline);

  await page.screenshot({ path: `${EVIDENCE}/02-waiting-polling-fired.png`, fullPage: true });
});

test("redirects to /pitch once matchingState flips to MATCHED", async ({ page }) => {
  // Padded with an extra leading WAITING: React StrictMode's double-invoked
  // mount effect consumes one state entry immediately, so MATCHED must not
  // land until after the fake-clock fast-forward below.
  await mockUserState(page, ["WAITING", "WAITING", "MATCHED"]);
  await seedUser(page);
  // Same fake-clock reasoning as above: the poll that returns MATCHED doesn't
  // fire for a full 60s of real time.
  await page.clock.install();
  await page.goto("/waiting");

  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __stateCallCount: number }).__stateCallCount)
    )
    .toBeGreaterThanOrEqual(1);

  await page.clock.fastForward(60_000);
  await expect(page).toHaveURL("/pitch", { timeout: 10_000 });

  await page.screenshot({ path: `${EVIDENCE}/03-waiting-redirects-to-pitch.png`, fullPage: true });
});
