import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/197-fix-date-assigned-crash-and-blind-date-page"
);
const EVIDENCE_58 = path.resolve(__dirname, "../../../docs/evidence/58-profile-reveal-ui");
const EVIDENCE_358 = path.resolve(
  __dirname,
  "../../../docs/evidence/358-route-into-debrief-after-date"
);

async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `blind-date-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Blind Date Test",
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

// route.fulfill does not reliably intercept requests through the Vite dev
// proxy — patching window.fetch directly guarantees the mock reaches the
// component, matching the pattern in pitch.spec.ts.
// followUpState defaults to AWAITING_DATE (date still ahead); pass
// "DATE_PASSED" to exercise the post-date debrief entrance (#358).
// universityVerified must be true — the verification gate is fail-closed, so
// omitting it would bounce every routed test to /authenticate.
async function mockBlindDateBackend(page: Page, followUpState = "AWAITING_DATE"): Promise<void> {
  await page.addInitScript((mockFollowUpState) => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

      if (/\/api\/users\/.+\/state$/.test(url)) {
        return new Response(
          JSON.stringify({
            matchingState: "DATE_ASSIGNED",
            hasProfile: true,
            universityVerified: true,
            followUpState: mockFollowUpState,
            // A DATE_ASSIGNED user always has a match, and /debrief refuses to
            // start without the matchId — `followUpState !== "DATE_PASSED" ||
            // !matchId` bounces to /waiting (Debrief.tsx). Omitting it made the
            // debrief-entrance test below a race it only sometimes won: the
            // click reached /debrief, the bounce fired, and the assertion passed
            // only when it sampled the URL first (#515). Mirrors debrief.spec.ts.
            matchedWith: "123e4567-e89b-12d3-a456-426614174001",
            matchId: "123e4567-e89b-12d3-a456-426614174002",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      // Only the debrief test reaches these — /debrief opens its own Barney
      // session on mount. Stubbed so landing there settles into a rendered
      // debrief rather than the init-error state, which would make the
      // evidence screenshot show a failure that is not the one under test.
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "123e4567-e89b-12d3-a456-426614174099" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message$/.test(url)) {
        return new Response(
          JSON.stringify({ reply: "Hey — how did the date go?", phaseComplete: false }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (/\/api\/users\/.+\/blind-date$/.test(url)) {
        return new Response(
          JSON.stringify({
            venue: "Aroma Coffee",
            dateTime: "2026-07-08T20:00:00.000Z",
            partnerName: "Sarah",
            partnerPhotoUrl:
              "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7",
            selfPhotoUrl:
              "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7",
            partnerProfile: {
              age: 29,
              city: "Tel Aviv",
              country: "Israel",
              height: null,
              job: "Marketing manager",
              hometown: "Haifa",
              conflict_style: "calmly and directly",
              emotional_openness: "Very open",
              treatment_of_others: "Warm and attentive",
              wants_kids: null,
              kids_timeline: null,
              faith: null,
              current_motivation: null,
              life_vision: null,
              hobbies: [{ name: "Hiking", centrality: "high", solo_or_social: "social" }],
              typical_weekend: null,
              social_energy: null,
              social_circle: null,
              photoUrls: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return _fetch(input, init);
    };
  }, followUpState);
}

test("shows the assigned Blind Date venue, time, and the revealed partner profile", async ({
  page,
}) => {
  await mockBlindDateBackend(page);
  await seedUser(page);
  await page.goto("/blind-date");

  await expect(page.getByText("It's a date.")).toBeVisible();
  await expect(page.getByText("Confirmed")).toBeVisible();
  await expect(page.getByText(/Aroma Coffee/)).toBeVisible();
  await expect(page.getByText(/29.*Tel Aviv/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to calendar" })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-blind-date-reveal.png`, fullPage: true });
});

test("shows the partner's name, photo, job, and a personality line", async ({ page }) => {
  await mockBlindDateBackend(page);
  await seedUser(page);
  await page.goto("/blind-date");

  await expect(page.getByText("Sarah", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "You and your match" })).toBeVisible();
  await expect(page.getByText("You + Sarah")).toBeVisible();
  await expect(page.getByText(/Marketing manager/)).toBeVisible();
  await expect(page.getByText("Handles conflict calmly and directly.")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE_58}/01-partner-details.png`, fullPage: true });
});

// #358: once the date has passed, the calendar button gives way to the
// debrief entrance — the page polls state and surfaces it without a reload.
test("shows the debrief entrance once the date has passed and it leads to /debrief", async ({
  page,
}) => {
  await mockBlindDateBackend(page, "DATE_PASSED");
  await seedUser(page);
  await page.goto("/blind-date");

  await expect(page.getByText("It's a date.")).toBeVisible();
  const cta = page.getByTestId("debrief-cta");
  await expect(cta).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to calendar" })).not.toBeVisible();
  await page.screenshot({ path: `${EVIDENCE_358}/01-debrief-entrance.png`, fullPage: true });

  await cta.click();
  await expect(page).toHaveURL(/\/debrief/, { timeout: 5_000 });
  await page.screenshot({ path: `${EVIDENCE_358}/02-lands-on-debrief.png`, fullPage: true });
});

test("logging in with matchingState DATE_ASSIGNED redirects to /blind-date", async ({ page }) => {
  await mockBlindDateBackend(page);
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/auth\/login$/.test(url)) {
        return new Response(
          JSON.stringify({
            id: "123e4567-e89b-12d3-a456-426614174000",
            email: "blind-date-login@example.com",
            name: "Blind Date Login",
            gender: "female",
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return _fetch(input, init);
    };
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill("blind-date-login@example.com");
  // Login now requires a password and the button reads "Log in" (#282). The
  // password value is irrelevant here — the /api/auth/login response is mocked
  // above — but the client-side form validation needs a non-empty field.
  await page.getByLabel("Password").fill("test-password-123");
  await page.getByRole("button", { name: /log in/i }).click();

  await expect(page).toHaveURL(/\/blind-date/, { timeout: 5_000 });
  await page.screenshot({
    path: `${EVIDENCE}/02-login-redirects-to-blind-date.png`,
    fullPage: true,
  });
});

test("unauthenticated user is redirected to /login", async ({ page }) => {
  await page.goto("/blind-date");
  await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
  await page.screenshot({ path: `${EVIDENCE}/03-unauthenticated-redirect.png`, fullPage: true });
});
