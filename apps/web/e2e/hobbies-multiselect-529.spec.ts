import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { pinInterviewLanguage } from "./support/interviewLanguage";

// This spec reads the chat surface's English copy while testing something
// else, so it pins the interview language rather than re-writing every
// selector in Hebrew. See support/interviewLanguage.ts and ADR-0037.
test.beforeEach(async ({ page }) => {
  await pinInterviewLanguage(page);
});
// Visual evidence for #529 — the hobbies question is now a multi-select with an
// "other" free-text field, replacing the free-text node whose answers were being
// extracted into a malformed shape and silently dropped.
//
// The turn is rendered from a canned SSE body (the interview engine and the
// model never run) so the screenshots are deterministic — the same
// window.fetch-patching pattern as barney-phase1.spec.ts and
// chat-flow-improvements-279.spec.ts, which the Vite dev proxy requires.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/529-collect-hobbies-via-multi-select-options-with-an-other-free-text-field"
);

const HOBBIES_TURN = [
  { type: "bubble_start", bubble: "acknowledgement" },
  { type: "delta", text: "Got it. " },
  { type: "bubble_start", bubble: "question" },
  {
    type: "delta",
    text: "What do you actually do in your free time — pick everything that fits, and add anything I've missed.",
  },
  {
    type: "done",
    phaseComplete: false,
    section: { title: "Hobbies & interests", index: 4, total: 6 },
    progress: { answered: 10, total: 16 },
    input: {
      kind: "multiChoice",
      allowFreeText: true,
      confirmLabel: "Done",
      options: [
        { label: "Cooking", value: "cooking" },
        { label: "Films & TV", value: "films" },
        { label: "Reading", value: "reading" },
        { label: "Music", value: "music" },
        { label: "Gym & fitness", value: "gym" },
        { label: "Running", value: "running" },
        { label: "Hiking", value: "hiking" },
        { label: "Travel", value: "travel" },
        { label: "Gaming", value: "gaming" },
        { label: "Photography", value: "photography" },
        { label: "Art & making", value: "art" },
        { label: "Dancing", value: "dancing" },
        { label: "Football", value: "football" },
        { label: "Yoga & pilates", value: "yoga" },
        { label: "Board games", value: "board games" },
        { label: "Volunteering", value: "volunteering" },
      ],
    },
  },
];

function toSse(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `hobbies-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Hobbies Test",
        phone,
        gender: "male",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status} - ${await res.text()}`);
    const user = await res.json();
    if (!user.id) throw new Error(`seedUser: missing id - ${JSON.stringify(user)}`);
    localStorage.setItem("user", JSON.stringify(user));
  });
}

async function mockPhase1Stream(page: Page, streamBody: string): Promise<void> {
  await page.addInitScript((body) => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "44444444-4444-4444-4444-444444444444" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message\/stream$/.test(url)) {
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return _fetch(input, init);
    };
  }, streamBody);
}

async function openHobbiesQuestion(page: Page): Promise<void> {
  await mockPhase1Stream(page, toSse(HOBBIES_TURN));
  await seedUser(page);
  await page.goto("/barney/phase1");
  await expect(page.getByText("Hobbies & interests")).toBeVisible({ timeout: 10_000 });
}

test("the hobbies question renders as a multi-select with an 'other' free-text field", async ({
  page,
}) => {
  await openHobbiesQuestion(page);

  await expect(page.getByRole("button", { name: "Cooking" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Board games" })).toBeVisible();
  await expect(page.getByText("Pick as many as you like")).toBeVisible();
  await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
  // The "other" entry — the composer doubles as the free-text field.
  await expect(page.getByPlaceholder("…anything else? add it here")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-multiselect-rendered.png`, fullPage: true });
});

test("selecting options marks them and counts them", async ({ page }) => {
  await openHobbiesQuestion(page);

  await page.getByRole("button", { name: "Cooking" }).click();
  await page.getByRole("button", { name: "Films & TV" }).click();
  await page.getByRole("button", { name: "Hiking" }).click();

  await expect(page.getByText("3 selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cooking" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("button", { name: "Reading" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );

  await page.screenshot({ path: `${EVIDENCE}/02-options-selected.png`, fullPage: true });
});

test("the 'other' free-text entry is merged into the selection, not sent instead of it", async ({
  page,
}) => {
  await openHobbiesQuestion(page);

  await page.getByRole("button", { name: "Cooking" }).click();
  await page.getByRole("button", { name: "Films & TV" }).click();
  await page.getByPlaceholder("…anything else? add it here").fill("woodworking");

  await page.screenshot({ path: `${EVIDENCE}/03-other-free-text-added.png`, fullPage: true });

  await page.getByRole("button", { name: "Done" }).click();

  // One message carrying both the ticked options and the typed addition.
  await expect(page.getByText("cooking, films, woodworking")).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: `${EVIDENCE}/04-merged-answer-sent.png`, fullPage: true });
});

test("the confirm control stays disabled until something is chosen or typed", async ({ page }) => {
  await openHobbiesQuestion(page);

  await expect(page.getByRole("button", { name: "Done" })).toBeDisabled();
  await page.getByRole("button", { name: "Yoga & pilates" }).click();
  await expect(page.getByRole("button", { name: "Done" })).toBeEnabled();

  await page.screenshot({ path: `${EVIDENCE}/05-confirm-enabled.png`, fullPage: true });
});
