import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/248-match-flow-design-fidelity");

const USER = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  email: "flow-248@example.com",
  name: "Flow Test",
  gender: "female",
  createdAt: "2026-01-01T00:00:00.000Z",
};

// A 1x1 gif so the reveal/date-card images render without a real photo.
const TINY_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7";

// Five ISO candidate slots for the choose-times picker.
const SLOTS = [
  "2026-07-16T16:00:00.000Z",
  "2026-07-17T17:30:00.000Z",
  "2026-07-18T18:00:00.000Z",
  "2026-07-19T19:30:00.000Z",
  "2026-07-20T20:00:00.000Z",
];

// Seeds the session and stubs every backend call each screen makes, driven by a
// per-test config object. window.fetch is patched directly because route.fulfill
// does not reliably intercept through the Vite dev proxy (see pitch.spec.ts).
async function installMock(
  page: Page,
  cfg: {
    state: unknown;
    // /state returns this instead once an availability POST has been made — lets
    // the proposer flow reflect "already submitted" after picking their times.
    stateAfterSubmit?: unknown;
    blindDate?: unknown;
    matchPhoto?: unknown;
    decide?: unknown;
    availability?: unknown;
  }
): Promise<void> {
  await page.addInitScript(
    ({ user, config }) => {
      localStorage.setItem("user", JSON.stringify(user));
      const _fetch = window.fetch.bind(window);
      let messageCount = 0;
      let availabilitySubmitted = false;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;

        if (/\/api\/users\/.+\/state$/.test(url)) {
          return json(
            availabilitySubmitted && config.stateAfterSubmit
              ? config.stateAfterSubmit
              : config.state
          );
        }
        if (/\/api\/users\/.+\/blind-date$/.test(url)) return json(config.blindDate);
        if (/\/api\/users\/.+\/match-photo$/.test(url)) return json(config.matchPhoto);
        if (/\/api\/barney\/session$/.test(url))
          return json({ sessionId: "123e4567-e89b-12d3-a456-426614174099" }, 201);
        if (/\/api\/barney\/message$/.test(url)) {
          messageCount += 1;
          return json({ reply: `Barney's answer number ${messageCount}.`, phaseComplete: false });
        }
        if (/\/api\/match\/decide$/.test(url)) return json(config.decide);
        if (/\/api\/match\/availability$/.test(url)) {
          availabilitySubmitted = true;
          return json(config.availability);
        }
        return _fetch(input, init);
      };
    },
    { user: USER, config: cfg }
  );
}

test("pitch decision screen and the post-yeah pending state", async ({ page }) => {
  await installMock(page, {
    state: {
      matchingState: "MATCHED",
      hasProfile: true,
      matchedWith: "123e4567-e89b-12d3-a456-426614174001",
      matchId: "123e4567-e89b-12d3-a456-426614174002",
    },
    matchPhoto: { photoUrl: TINY_GIF },
    decide: { waiting: true },
  });
  await page.goto("/pitch");

  // The pitch now opens on the "Introducing…" reveal card (ADR-0022) — tap into
  // the genie chat before the questions.
  await page.getByRole("button", { name: "Send a wish" }).click();

  const input = page.getByRole("textbox");
  const send = page.getByRole("button", { name: "Send" });
  for (const q of ["What do they do?", "Their hobbies?", "Why us?"]) {
    await input.fill(q);
    await send.click();
    await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible({
      timeout: 15_000,
    });
  }

  // Genie fix (#279): after the 3rd answer a "See who it is" button gates the
  // reveal/decision screen instead of swapping to it automatically.
  const seeWhoItIs = page.getByRole("button", { name: "See who it is" });
  await expect(seeWhoItIs).toBeVisible({ timeout: 15_000 });
  await seeWhoItIs.click();

  await expect(page.getByText("The Introduction")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("your kind of person?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yeah" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Neh" })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/01-pitch-decision.png`, fullPage: true });

  await page.getByRole("button", { name: "Yeah" }).click();
  await expect(page.getByText("You said yeah.")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Pending")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/02-pitch-pending.png`, fullPage: true });
});

test("choose-times — proposer picks up to three of the offered slots", async ({ page }) => {
  await installMock(page, {
    state: {
      matchingState: "CHOOSING_TIMES",
      hasProfile: true,
      matchId: "123e4567-e89b-12d3-a456-426614174002",
      timeRole: "proposer",
      candidateSlots: SLOTS,
      hasSubmittedAvailability: false,
    },
    // After the proposer submits, /state reports them as having picked, so the
    // page holds on the waiting screen instead of bouncing back to the picker.
    stateAfterSubmit: {
      matchingState: "CHOOSING_TIMES",
      hasProfile: true,
      matchId: "123e4567-e89b-12d3-a456-426614174002",
      timeRole: "proposer",
      candidateSlots: SLOTS,
      hasSubmittedAvailability: true,
    },
    availability: { waiting: true, matchingState: "CHOOSING_TIMES" },
  });
  await page.goto("/choose-times");

  await expect(page.getByText("When are you free?")).toBeVisible();
  await expect(page.getByText("0 / 3")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/03-choose-times-proposer.png`, fullPage: true });

  const slots = page.getByTestId("time-slot");
  await slots.nth(0).click();
  await slots.nth(1).click();
  await slots.nth(2).click();
  await expect(page.getByText("3 / 3")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/04-choose-times-selected.png`, fullPage: true });

  await page.getByRole("button", { name: "Send my times" }).click();
  await expect(page.getByText("Times sent.")).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: `${EVIDENCE}/05-choose-times-pending.png`, fullPage: true });
});

test("choose-times — chooser picks the one final slot and lands on the date", async ({ page }) => {
  const PROPOSED = SLOTS.slice(0, 3);
  await installMock(page, {
    state: {
      matchingState: "CHOOSING_TIMES",
      hasProfile: true,
      matchId: "123e4567-e89b-12d3-a456-426614174002",
      timeRole: "chooser",
      proposedSlots: PROPOSED,
      hasSubmittedAvailability: false,
    },
    availability: { waiting: false, matchingState: "DATE_ASSIGNED" },
    blindDate: {
      venue: "Port Sa'id",
      dateTime: PROPOSED[1],
      partnerName: "Yael Cohen",
      partnerPhotoUrl: TINY_GIF,
      selfPhotoUrl: TINY_GIF,
      partnerProfile: {
        age: 28,
        city: "Tel Aviv",
        country: "Israel",
        height: null,
        job: "Product designer",
        hometown: "Haifa",
        conflict_style: "calmly and directly",
        emotional_openness: "Very open",
        treatment_of_others: "Warm and attentive",
        wants_kids: null,
        kids_timeline: null,
        faith: null,
        current_motivation: null,
        life_vision: null,
        hobbies: [],
        typical_weekend: null,
        social_energy: null,
        social_circle: null,
        photoUrls: [],
      },
    },
  });
  await page.goto("/choose-times");

  await expect(page.getByText("Pick your date.")).toBeVisible();
  await expect(page.getByText("0 / 1")).toBeVisible();
  await expect(page.getByTestId("time-slot")).toHaveCount(3);

  await page.getByTestId("time-slot").nth(1).click();
  await expect(page.getByText("1 / 1")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/06-choose-times-chooser.png`, fullPage: true });

  await page.getByRole("button", { name: "Confirm date" }).click();
  await expect(page).toHaveURL(/\/blind-date/, { timeout: 5_000 });
  await expect(page.getByText("It's a date.")).toBeVisible();
});

test("it's a date confirmation card", async ({ page }) => {
  await installMock(page, {
    state: { matchingState: "DATE_ASSIGNED", hasProfile: true },
    blindDate: {
      venue: "Port Sa'id",
      dateTime: "2026-07-18T18:00:00.000Z",
      partnerName: "Yael Cohen",
      partnerPhotoUrl: TINY_GIF,
      selfPhotoUrl: TINY_GIF,
      partnerProfile: {
        age: 28,
        city: "Tel Aviv",
        country: "Israel",
        height: null,
        job: "Product designer",
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
    },
  });
  await page.goto("/blind-date");

  await expect(page.getByText("It's a date.")).toBeVisible();
  await expect(page.getByText("Confirmed")).toBeVisible();
  await expect(page.getByText("Yael Cohen")).toBeVisible();
  await expect(page.getByText("You + Yael")).toBeVisible();
  await expect(page.getByText("Port Sa'id")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to calendar" })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/07-date-card.png`, fullPage: true });
});
