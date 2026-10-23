import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// Visual evidence for #297: the real app now carries the demo walkthrough's
// design — the splash/welcome/verified screens exist as real pages (the
// concierge intro was removed in #327),
// and the pitch opens on the "Introducing…" reveal card (ADR-0022) that names
// the match and shows their education.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/297-align-real-app-to-demo-design"
);

// A 1x1 gif so the reveal card renders an image without a real photo upload.
const TINY_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7";

const USER = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  email: "design-297@example.com",
  name: "Design Test",
  gender: "female",
  createdAt: "2026-01-01T00:00:00.000Z",
};

// Seeds the session and stubs the pitch backend — MATCHED state, a match photo
// carrying the partner's name + education (ADR-0022), and numbered genie
// answers. window.fetch is patched directly because route.fulfill does not
// reliably intercept through the Vite dev proxy (see pitch.spec.ts).
async function mockPitchBackend(page: Page): Promise<void> {
  await page.addInitScript(
    ({ user, photo }) => {
      localStorage.setItem("user", JSON.stringify(user));
      const _fetch = window.fetch.bind(window);
      let messageCount = 0;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        if (/\/api\/users\/.+\/state$/.test(url)) {
          return json({
            matchingState: "MATCHED",
            hasProfile: true,
            matchedWith: "123e4567-e89b-12d3-a456-426614174001",
            matchId: "123e4567-e89b-12d3-a456-426614174002",
          });
        }
        if (/\/api\/users\/.+\/match-photo$/.test(url)) {
          return json({ photoUrl: photo, partnerName: "Yael", education: "Tel Aviv University" });
        }
        if (/\/api\/barney\/session$/.test(url)) {
          return json({ sessionId: "123e4567-e89b-12d3-a456-426614174099" }, 201);
        }
        if (/\/api\/barney\/message$/.test(url)) {
          messageCount += 1;
          return json({ reply: `Barney's answer number ${messageCount}.`, phaseComplete: false });
        }
        return _fetch(input, init);
      };
    },
    { user: USER, photo: TINY_GIF }
  );
}

test("splash leads to the welcome screen with sign-up and log-in", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Wingman", { exact: true })).toBeVisible();
  const getStarted = page.getByRole("button", { name: "Get Started" });
  await expect(getStarted).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/01-splash.png`, fullPage: true });

  await getStarted.click();
  await expect(page).toHaveURL("/welcome");
  await expect(page.getByText("Built for Students.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign Up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log In" })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/02-welcome.png`, fullPage: true });
});

test("verified confirmation continues straight into the interview (#327)", async ({ page }) => {
  // Phase 1 (unlike the removed Concierge teaser) requires a signed-in user
  // and a live session — seed both with the same stubs the pitch tests use.
  await mockPitchBackend(page);
  await page.goto("/verified");

  await expect(page.getByText("You're Verified")).toBeVisible();
  await expect(page.getByText("Welcome to Wingman.")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/03-verified.png`, fullPage: true });

  // The Concierge intro that used to sit here was removed in #327 — Continue
  // lands directly on the Phase 1 chat.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("/barney/phase1");
  // The chat is live: Barney's opening message arrives (mocked backend).
  await expect(page.getByText("Barney's answer number 1.")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${EVIDENCE}/04-interview.png`, fullPage: true });
});

test("pitch opens on the Introducing card with the match's name and education (ADR-0022)", async ({
  page,
}) => {
  await mockPitchBackend(page);
  await page.goto("/pitch");

  // The reveal card names the match and shows their education up front.
  await expect(page.getByText("Introducing")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Yael", { exact: true })).toBeVisible();
  await expect(page.getByText("Tel Aviv University")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/05-pitch-introducing-card.png`, fullPage: true });

  // "Send a wish" drops into the 3-question genie chat.
  await page.getByRole("button", { name: "Send a wish" }).click();
  await expect(page.getByLabel("3 wishes left")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${EVIDENCE}/06-pitch-genie-chat.png`, fullPage: true });
});

test("Maybe later skips the genie chat straight to the named decision", async ({ page }) => {
  await mockPitchBackend(page);
  await page.goto("/pitch");

  await expect(page.getByText("Introducing")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Maybe later" }).click();

  // The decision screen addresses the match by name (ADR-0022).
  await expect(page.getByText("Is Yael")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Yeah" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Neh" })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/07-pitch-named-decision.png`, fullPage: true });
});
