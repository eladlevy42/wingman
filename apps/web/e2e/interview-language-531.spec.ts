import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// Visual evidence for #531 — the interview runs in Hebrew by default, with a
// flag toggle to English, RTL layout in Hebrew, and the choice persisting
// across a reload. See docs/adr/0037-interview-runs-in-hebrew-by-default.md.
//
// The turn is rendered from a canned SSE body (the engine and the model never
// run) so the screenshots are deterministic — the same window.fetch-patching
// pattern as hobbies-multiselect-529.spec.ts. The mock reads the `language` the
// client sent and answers in it, which is exactly the contract under test: the
// language travels on every turn, not only at session creation.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/531-run-the-interview-in-hebrew-by-default-with-an-en-he-toggle"
);

const HE_TURN = [
  { type: "bubble_start", bubble: "acknowledgement" },
  {
    type: "delta",
    text: "[redacted:he] ",
  },
  { type: "bubble_start", bubble: "question" },
  { type: "delta", text: "אמונה או רוחניות הן חלק מהחיים שלכם בדרך כלשהי?" },
  {
    type: "done",
    phaseComplete: false,
    section: { title: "מה חשוב לכם", index: 3, total: 6 },
    progress: { answered: 8, total: 18 },
    input: {
      kind: "choice",
      allowFreeText: true,
      options: [
        { label: "כן, חשוב לי", value: "כן, אמונה ורוחניות חשובות לי." },
        { label: "במידה מסוימת", value: "במידה מסוימת — יש לזה מקום קטן בחיים שלי." },
        { label: "לא ממש", value: "לא ממש — אמונה היא לא חלק מהחיים שלי." },
        { label: "מעדיפים לא לענות", value: "אני מעדיף לא לענות." },
      ],
    },
  },
];

const EN_TURN = [
  { type: "bubble_start", bubble: "question" },
  { type: "delta", text: "Is faith or spirituality part of your life in any way?" },
  {
    type: "done",
    phaseComplete: false,
    section: { title: "What matters to you", index: 3, total: 6 },
    progress: { answered: 8, total: 18 },
    input: {
      kind: "choice",
      allowFreeText: true,
      options: [
        { label: "Yes, important to me", value: "Yes, faith/spirituality is important to me." },
        { label: "Somewhat", value: "Somewhat — it plays a small role in my life." },
        { label: "Not really", value: "Not really — faith isn't part of my life." },
        { label: "Prefer not to say", value: "I'd rather not say." },
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
    const email = `lang-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Language Test",
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

// Answers each streamed turn in whichever language the client asked for, so the
// test exercises the real "language on every turn" wire contract rather than a
// fixed reply.
async function mockPhase1(page: Page): Promise<void> {
  await page.addInitScript(
    ([he, en]) => {
      const _fetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        if (/\/api\/barney\/session$/.test(url)) {
          return new Response(
            JSON.stringify({ sessionId: "53153153-5315-4315-8315-531531531531" }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        if (/\/api\/barney\/message\/stream$/.test(url)) {
          let language = "he";
          try {
            language = JSON.parse(String(init?.body ?? "{}")).language ?? "he";
          } catch {
            // Fall through to Hebrew — the server's own default.
          }
          return new Response(language === "en" ? en : he, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return _fetch(input, init);
      };
    },
    [toSse(HE_TURN), toSse(EN_TURN)]
  );
}

async function openPhase1(page: Page): Promise<void> {
  await mockPhase1(page);
  await seedUser(page);
  await page.goto("/barney/phase1");
}

test("the interview opens in Hebrew, laid out right-to-left", async ({ page }) => {
  await openPhase1(page);

  await expect(page.getByText("מה חשוב לכם")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("אמונה או רוחניות הן חלק מהחיים שלכם בדרך כלשהי?")).toBeVisible();
  // The chat surface — not the whole document — carries the direction.
  await expect(page.getByTestId("chat-surface")).toHaveAttribute("dir", "rtl");
  // The surface's own copy follows too, not just the server's words.
  await expect(page.getByPlaceholder("…או במילים שלכם")).toBeVisible();
  await expect(page.getByRole("button", { name: "כן, חשוב לי" })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-hebrew-default-rtl.png`, fullPage: true });
});

test("the flag toggle switches the interview to English and back", async ({ page }) => {
  await openPhase1(page);
  await expect(page.getByText("מה חשוב לכם")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("language-en").click();

  // The surface's own copy flips immediately, and the layout with it.
  await expect(page.getByPlaceholder("…or say it in your own words")).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("language-en")).toHaveAttribute("aria-pressed", "true");

  await page.screenshot({ path: `${EVIDENCE}/02-english-after-toggle.png`, fullPage: true });

  await page.getByTestId("language-he").click();
  await expect(page.getByTestId("chat-surface")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("language-he")).toHaveAttribute("aria-pressed", "true");

  await page.screenshot({ path: `${EVIDENCE}/03-back-to-hebrew.png`, fullPage: true });
});

test("the language choice survives a reload, and the next turn is asked in it", async ({
  page,
}) => {
  await openPhase1(page);
  await expect(page.getByText("מה חשוב לכם")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("language-en").click();
  await page.reload();

  // Restored from storage before the session is opened, so the whole
  // conversation restarts in English rather than flashing Hebrew first.
  await expect(page.getByText("What matters to you")).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("Is faith or spirituality part of your life in any way?")
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("language-en")).toHaveAttribute("aria-pressed", "true");

  await page.screenshot({ path: `${EVIDENCE}/04-english-persisted-after-reload.png` });
});
