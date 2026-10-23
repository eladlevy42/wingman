import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/509-photo-gate-is-client-side-only"
);

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function seedUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    const ts = Date.now();
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `photo-gate-509-${ts}@example.com`,
        name: "Photo Gate 509",
        phone: `+1555${(ts % 10_000_000).toString().padStart(7, "0")}`,
        gender: "female",
        password: "test-password-123",
      }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status} - ${await res.text()}`);
    localStorage.setItem("user", JSON.stringify(await res.json()));
  });
}

// Two things are simulated here, and only two.
//
// `/api/barney/message` is stubbed so no Claude call is needed — the same
// approach barney-phase2-photo.spec.ts uses. But that stub means the server
// never actually persists the WantedProfile, so the user never reaches
// WAITING, which is the state this bug lives in. So `/state` also has its
// matchingState rewritten to WAITING.
//
// `hasPhoto` is deliberately NOT touched: it comes straight from the real
// server, derived from the real photoUrl the real upload endpoint writes.
// That is the field under test, and the moment it is faked the test stops
// proving anything. Reaching WAITING honestly would need a full Claude
// interview per run.
//
// page.route is not used for any of this: it does not intercept in this
// setup, which is why the suite patches window.fetch instead.
async function mockPhaseCompleteAndWaiting(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Survives the reload, exactly as the server-side transition would: once
    // the interview has completed the user is WAITING from then on, not just
    // for the rest of that page load.
    const FLAG = "e2e-509-phase-complete";
    const _fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/barney\/message$/.test(url)) {
        localStorage.setItem(FLAG, "1");
        return new Response(
          JSON.stringify({
            reply: "Got a clear picture of what you're after — locking that in.",
            phaseComplete: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (/\/api\/users\/[^/]+\/state$/.test(url)) {
        const res = await _fetch(input, init);
        if (!res.ok || localStorage.getItem(FLAG) !== "1") return res;
        const body = await res.json();
        // Only the transition the stubbed interview could not perform.
        return new Response(JSON.stringify({ ...body, matchingState: "WAITING" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return _fetch(input, init);
    };
  });
}

// Drives Phase 2 to completion and stops at the photo request — the exact
// state the bug lives in. Completing the interview has already flipped the
// user to WAITING server-side; photoUrl is still null.
async function completePhase2WithoutUploading(page: Page): Promise<void> {
  await mockPhaseCompleteAndWaiting(page);
  await seedUser(page);
  await page.goto("/barney/phase2");
  // The screen sends the opening turn itself on init; the stub completes the
  // phase on that turn, which is what flips the user to WAITING and puts the
  // photo request on screen.
  await expect(page.getByText("One more thing before I go match-making")).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("the photo gate survives a kill between Phase 2 and the upload (#509)", () => {
  test("relaunching without uploading returns to the photo step, not past it", async ({ page }) => {
    await completePhase2WithoutUploading(page);

    await page.screenshot({
      path: path.join(EVIDENCE, "01-photo-request-before-the-kill.png"),
      fullPage: true,
    });

    // The kill: the app goes away between the last interview turn and the
    // upload. A reload is the browser's version of the relaunch.
    await page.reload();

    // Before this fix, /state said WAITING and the client routed to /waiting —
    // past the photo, permanently, because nothing ever asks again.
    await expect(page).toHaveURL(/\/barney\/phase2$/);
    await expect(page.getByRole("heading", { name: "One thing left" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/Barney is already out looking\. He still needs a photo/)
    ).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE, "02-relaunch-lands-back-on-the-photo-step.png"),
      fullPage: true,
    });

    // The interview must not restart: this user's WantedProfile is already
    // saved, and a second interview_wants session would overwrite it.
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByText("Now tell me what you are looking for.")).toHaveCount(0);

    // The upload is the real endpoint, and it releases the gate.
    await page.getByLabel("Choose a photo").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    });
    await expect(page.getByAltText("Your selected photo")).toBeVisible();
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText("Photo saved!")).toBeVisible({ timeout: 10_000 });

    // Rejoins where matching already put them, rather than being walked back
    // through the post-interview completion hand-off.
    await expect(page).toHaveURL(/\/waiting$/, { timeout: 10_000 });

    await page.screenshot({
      path: path.join(EVIDENCE, "03-upload-releases-the-gate.png"),
      fullPage: true,
    });
  });

  test("a second relaunch after uploading is let through", async ({ page }) => {
    await completePhase2WithoutUploading(page);
    await page.reload();

    await page.getByLabel("Choose a photo").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page).toHaveURL(/\/waiting$/, { timeout: 10_000 });

    // The gate is released by state, not by a flag this session happens to
    // hold — so going back to Phase 2 now bounces forward rather than asking
    // for a photo the user has already given.
    await page.goto("/barney/phase2");
    await expect(page).toHaveURL(/\/waiting$/, { timeout: 15_000 });

    await page.screenshot({
      path: path.join(EVIDENCE, "04-gate-stays-released.png"),
      fullPage: true,
    });
  });
});
