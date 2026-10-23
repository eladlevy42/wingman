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
// Visual evidence for the #279 chat-flow improvements. Every state is rendered
// from canned backend responses (the interview engine / model never runs) so the
// screenshots are deterministic — same window.fetch-patching pattern as
// barney-phase1.spec.ts / pitch.spec.ts, which the Vite dev proxy requires.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/279-chat-flow-improvements");

async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `chatflow-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "ChatFlow Test",
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

function toSse(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

// Phase 1 streams over /message/stream — a canned SSE body plus the done event's
// input descriptor fully determine what renders.
async function mockPhase1Stream(page: Page, streamBody: string): Promise<void> {
  await page.addInitScript((body) => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "22222222-2222-2222-2222-222222222222" }), {
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

// Phase 2 is non-streaming: /state must map to /barney/phase2 (hasProfile true +
// IDLE), then /session, then the "start" /message returns the canned turn.
async function mockPhase2Message(page: Page, turn: object): Promise<void> {
  await page.addInitScript((turnJson) => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/users\/.+\/state$/.test(url)) {
        return new Response(JSON.stringify({ matchingState: "IDLE", hasProfile: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "33333333-3333-3333-3333-333333333333" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message$/.test(url)) {
        return new Response(JSON.stringify(turnJson), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return _fetch(input, init);
    };
  }, turn);
}

// #1 (reorder) + #6 (back): the appearance question now opens the final "Looks &
// style" section, and the header carries the Back control on every turn.
test("Phase 1 asks the new appearance question in the final 'Looks & style' section, with a Back control", async ({
  page,
}) => {
  await mockPhase1Stream(
    page,
    toSse([
      { type: "bubble_start", bubble: "question" },
      {
        type: "delta",
        text: "Last stretch — let's talk looks. How would you describe your appearance and style?",
      },
      {
        type: "done",
        phaseComplete: false,
        section: { title: "Looks & style", index: 6, total: 6 },
        progress: { answered: 14, total: 16 },
        input: { kind: "text" },
      },
    ])
  );
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText("Looks & style")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("15 / 16")).toBeVisible();
  await expect(page.getByText("How would you describe your appearance and style?")).toBeVisible();
  // #6: the Back control is present so the user can revise an earlier answer.
  await expect(
    page.getByRole("button", { name: "Go back to the previous question" })
  ).toBeVisible();

  await page.screenshot({
    path: `${EVIDENCE}/01-appearance-question-and-back.png`,
    fullPage: true,
  });
});

// #1 (reorder): body-type now follows the appearance question, still inside the
// final "Looks & style" section — the build question comes last, as asked.
test("Phase 1 asks the body-type question after appearance, still in 'Looks & style'", async ({
  page,
}) => {
  await mockPhase1Stream(
    page,
    toSse([
      { type: "bubble_start", bubble: "acknowledgement" },
      { type: "delta", text: "Love it. " },
      { type: "bubble_start", bubble: "question" },
      { type: "delta", text: "And how would you describe your build?" },
      {
        type: "done",
        phaseComplete: false,
        section: { title: "Looks & style", index: 6, total: 6 },
        progress: { answered: 15, total: 16 },
        input: { kind: "text" },
      },
    ])
  );
  await seedUser(page);
  await page.goto("/barney/phase1");

  await expect(page.getByText("Looks & style")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("And how would you describe your build?")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-body-type-after-appearance.png`, fullPage: true });
});

// #7 (tappable distance): driving-time options mapped to km, no typing required.
test("Phase 2 distance question offers tappable driving-time options", async ({ page }) => {
  await mockPhase2Message(page, {
    reply: "How far would you travel for the right person?",
    phaseComplete: false,
    section: { title: "Who they are", index: 1, total: 7 },
    progress: { answered: 3, total: 10 },
    input: {
      kind: "choice",
      allowFreeText: true,
      options: [
        { label: "Up to 15 min away", value: "15 km" },
        { label: "Up to 30 min away", value: "30 km" },
        { label: "Up to 45 min away", value: "50 km" },
        { label: "Up to an hour away", value: "80 km" },
        { label: "Distance is no issue", value: "500 km" },
      ],
    },
  });
  await seedUser(page);
  await page.goto("/barney/phase2");

  await expect(page.getByText("How far would you travel for the right person?")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Up to 15 min away" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Up to 30 min away" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Up to an hour away" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Distance is no issue" })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/03-distance-driving-time.png`, fullPage: true });
});

// #5 (18+): the Phase 2 partner-age picker cannot offer a value under 18.
test("Phase 2 age question enforces an 18+ minimum", async ({ page }) => {
  await mockPhase2Message(page, {
    reply: "What's the youngest age you'd want them to be?",
    phaseComplete: false,
    section: { title: "Who they are", index: 1, total: 7 },
    progress: { answered: 1, total: 10 },
    input: { kind: "age", min: 18, max: 120 },
  });
  await seedUser(page);
  await page.goto("/barney/phase2");

  await expect(page.getByText("What's the youngest age you'd want them to be?")).toBeVisible({
    timeout: 10_000,
  });
  const agePicker = page.getByLabel("Your age");
  await expect(agePicker).toBeVisible();
  // First selectable age is 18 — under-18 can never be chosen.
  await expect(agePicker.locator("option").first()).toHaveText("18");

  await page.screenshot({ path: `${EVIDENCE}/04-age-18-plus-phase2.png`, fullPage: true });
});

// Pitch/genie mock: MATCHED state + a match photo, and each question returns a
// numbered Barney answer so the 3rd answer is identifiable on screen.
async function mockPitchBackend(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    let messageCount = 0;
    // 2x2 transparent PNG so the reveal renders a real <img>.
    const photo =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/users\/.+\/state$/.test(url)) {
        return new Response(
          JSON.stringify({
            matchingState: "MATCHED",
            hasProfile: true,
            matchedWith: "123e4567-e89b-12d3-a456-426614174001",
            matchId: "123e4567-e89b-12d3-a456-426614174002",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (/\/api\/barney\/session$/.test(url)) {
        return new Response(JSON.stringify({ sessionId: "123e4567-e89b-12d3-a456-426614174099" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/barney\/message$/.test(url)) {
        messageCount += 1;
        return new Response(
          JSON.stringify({
            reply: `Barney's answer number ${messageCount}.`,
            phaseComplete: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (/\/api\/users\/.+\/match-photo$/.test(url)) {
        return new Response(JSON.stringify({ photoUrl: photo }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return _fetch(input, init);
    };
  });
}

// Genie bug fix (#279): after the 3rd question, Barney's final answer stays on
// screen behind a "See who it is" button, instead of the reveal snapping in and
// hiding the answer.
test("Pitch shows the 3rd answer with a 'See who it is' gate, then reveals the decision", async ({
  page,
}) => {
  await mockPitchBackend(page);
  await seedUser(page);
  await page.goto("/pitch");

  // The pitch now opens on the "Introducing…" reveal card (ADR-0022) — tap into
  // the genie chat before the questions.
  await page.getByRole("button", { name: "Send a wish" }).click();

  await expect(page.getByRole("status", { name: "Barney is typing" })).not.toBeVisible({
    timeout: 15_000,
  });

  const input = page.getByRole("textbox");
  const sendButton = page.getByRole("button", { name: "Send" });

  await input.fill("What do they do for a living?");
  await sendButton.click();
  await expect(page.getByLabel("2 wishes left")).toBeVisible({ timeout: 15_000 });

  await input.fill("What are their hobbies?");
  await sendButton.click();
  await expect(page.getByLabel("1 wish left")).toBeVisible({ timeout: 15_000 });

  await input.fill("Why do you think we're compatible?");
  await sendButton.click();

  // The 3rd answer is still visible, and a "See who it is" button gates the reveal.
  const seeWhoItIs = page.getByRole("button", { name: "See who it is" });
  await expect(seeWhoItIs).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Barney's answer number 3.")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/05-genie-third-answer-visible.png`, fullPage: true });

  await seeWhoItIs.click();

  await expect(page.getByText("The Introduction")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("your kind of person?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yeah" })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/06-genie-decision-reveal.png`, fullPage: true });
});
