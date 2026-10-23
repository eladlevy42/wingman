import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/200-photo-upload-registration");

// 1x1 transparent PNG — stands in for a real photo upload in tests.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Registers a fresh user and seeds localStorage so tests start with a valid
// session without going through the register form.
async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const email = `phase2-photo-${ts}@example.com`;
    const phone = `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`;
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Phase2 Photo Test",
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

// Only /api/barney/message is mocked (no Claude API key needed in CI) — the
// photo upload itself hits the real POST /api/users/:id/photo endpoint, so
// this exercises the genuine persistence path, not a stub.
async function mockPhaseCompleteReply(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/barney\/message$/.test(url)) {
        return new Response(
          JSON.stringify({
            reply: "Got a clear picture of what you're after — locking that in.",
            phaseComplete: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return _fetch(input, init);
    };
  });
}

test("upload a photo after Phase 2 completes, then transition to /completion", async ({ page }) => {
  await mockPhaseCompleteReply(page);
  await seedUser(page);
  await page.goto("/barney/phase2");

  await expect(page.getByText("One more thing before I go match-making")).toBeVisible({
    timeout: 15_000,
  });

  await page.screenshot({ path: `${EVIDENCE}/01-photo-request-shown.png`, fullPage: true });

  await page.getByLabel("Choose a photo").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  });

  await expect(page.getByAltText("Your selected photo")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-photo-preview-shown.png`, fullPage: true });

  await page.getByRole("button", { name: "Upload" }).click();

  await expect(page.getByText("Photo saved!")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Moving to matching...")).toBeVisible({ timeout: 5_000 });

  await page.screenshot({ path: `${EVIDENCE}/03-photo-saved-transition.png`, fullPage: true });

  // Navigation must follow within the 1500ms delay + test buffer.
  await expect(page).toHaveURL(/\/completion/, { timeout: 5_000 });

  await page.screenshot({ path: `${EVIDENCE}/04-completion-page-reached.png`, fullPage: true });
});

test("rejects a non-image file with an inline error and does not upload", async ({ page }) => {
  await mockPhaseCompleteReply(page);
  await seedUser(page);
  await page.goto("/barney/phase2");

  await expect(page.getByText("One more thing before I go match-making")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByLabel("Choose a photo").setInputFiles({
    name: "resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not an image"),
  });

  await expect(
    page.getByText("That doesn't look like a photo — try a JPG, PNG, or WEBP.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload" })).not.toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/05-non-image-rejected.png`, fullPage: true });
});

test("lets the user choose a different photo before uploading", async ({ page }) => {
  await mockPhaseCompleteReply(page);
  await seedUser(page);
  await page.goto("/barney/phase2");

  await expect(page.getByText("One more thing before I go match-making")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByLabel("Choose a photo").setInputFiles({
    name: "first.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  });
  await expect(page.getByAltText("Your selected photo")).toBeVisible();

  const replaceInput = page.getByLabel("Choose a different photo");
  await expect(replaceInput).toBeAttached();
  await replaceInput.setInputFiles({
    name: "second.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  });

  await expect(page.getByAltText("Your selected photo")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload" })).toBeVisible();
});
