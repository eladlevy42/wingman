import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { pinInterviewLanguage } from "./support/interviewLanguage";

// Visual evidence for #566 — the chat surface's own Hebrew copy (composer
// placeholder, chip hints, length warning) addresses the user by their
// registered gender, the same way Barney's own lines already do (#541). See
// packages/shared/src/i18n.ts (chatStrings) and
// apps/api/src/agents/interview/localized.ts (ADR-0037).
//
// Same deterministic-mock pattern as interview-language-531.spec.ts: the turn
// is served from a canned SSE body, so the model and matching engine never
// run and the screenshot is reproducible.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/566-chat-ui-copy-addresses-user-by-gender-in-hebrew"
);

const HE_TURN = [
  { type: "bubble_start", bubble: "acknowledgement" },
  { type: "delta", text: "[redacted:he]" },
  { type: "bubble_start", bubble: "question" },
  { type: "delta", text: "מה הכי חשוב לך בבן/בת זוג?" },
  {
    type: "done",
    phaseComplete: false,
    section: { title: "מה חשוב לך", index: 1, total: 6 },
    progress: { answered: 1, total: 18 },
    input: { kind: "text" },
  },
];

function toSse(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function seedUser(page: Page, gender: "male" | "female"): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async (gender) => {
    const ts = Date.now();
    const email = `gendered-copy-${gender}-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: gender === "female" ? "Gendered Copy Test (F)" : "Gendered Copy Test (M)",
        phone,
        gender,
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status} - ${await res.text()}`);
    const user = await res.json();
    if (!user.id) throw new Error(`seedUser: missing id - ${JSON.stringify(user)}`);
    localStorage.setItem("user", JSON.stringify(user));
  }, gender);
}

async function mockPhase1(page: Page): Promise<void> {
  await page.addInitScript(
    ([he]) => {
      const _fetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        if (/\/api\/barney\/session$/.test(url)) {
          return new Response(
            JSON.stringify({ sessionId: "56656656-5665-4665-8665-566566566566" }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        if (/\/api\/barney\/message\/stream$/.test(url)) {
          return new Response(he, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return _fetch(input, init);
      };
    },
    [toSse(HE_TURN)]
  );
}

async function openPhase1(page: Page, gender: "male" | "female"): Promise<void> {
  await pinInterviewLanguage(page, "he");
  await mockPhase1(page);
  await seedUser(page, gender);
  await page.goto("/barney/phase1");
}

test("a female user sees the feminine composer placeholder in Hebrew", async ({ page }) => {
  await openPhase1(page, "female");

  await expect(page.getByText("מה הכי חשוב לך בבן/בת זוג?")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder("כתבי את התשובה שלך...")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-feminine-placeholder.png`, fullPage: true });
});

test("a male user sees the masculine composer placeholder in Hebrew", async ({ page }) => {
  await openPhase1(page, "male");

  await expect(page.getByText("מה הכי חשוב לך בבן/בת זוג?")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder("כתוב את התשובה שלך...")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-masculine-placeholder.png`, fullPage: true });
});
