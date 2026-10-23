import { test, expect, type Page, type Request } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// Screenshot paths resolve from the config's cwd (apps/web), so the repo-root
// evidence folder is addressed explicitly — the same shape register.spec.ts uses.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/554-client-telemetry");

// #554 — proves the client actually emits, the endpoint actually accepts, and
// the payloads carry no content. Unit tests cover each half; this is the only
// place the two meet over a real network call.

interface TelemetryBatch {
  userId?: string;
  anonSessionId?: string;
  events: { type: string; payload: Record<string, unknown> }[];
}

function captureTelemetry(page: Page): {
  batches: TelemetryBatch[];
  responses: { status: number; body: unknown }[];
} {
  const batches: TelemetryBatch[] = [];
  const responses: { status: number; body: unknown }[] = [];

  page.on("request", (request: Request) => {
    if (!request.url().includes("/api/telemetry")) return;
    batches.push(JSON.parse(request.postData() ?? "{}") as TelemetryBatch);
  });
  page.on("response", async (response) => {
    if (!response.url().includes("/api/telemetry")) return;
    responses.push({ status: response.status(), body: await response.json().catch(() => null) });
  });

  return { batches, responses };
}

// The app flushes on an interval and when the tab is hidden. Hiding it is the
// deterministic trigger, and it is also the behaviour that matters most —
// someone closing the tab on Register is exactly the drop-off being measured.
async function flushByHidingTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("screen views and a funnel tap reach the telemetry endpoint", async ({ page }) => {
  const captured = captureTelemetry(page);

  await page.goto("/");
  await expect(page.getByText("Wingman")).toBeVisible();
  // In-app navigation, not a second goto: the router listener is the mechanism
  // under test, and a fresh page load would start a new queue and a new
  // anonymous id.
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page).toHaveURL(/\/welcome/);

  await flushByHidingTab(page);
  await expect.poll(() => captured.batches.length).toBeGreaterThan(0);

  const firstLoad = captured.batches.flatMap((batch) => batch.events);
  const screens = firstLoad
    .filter((event) => event.type === "SCREEN_VIEWED")
    .map((event) => event.payload.screen);
  // Both screens of the one session, in the order they were seen, and each
  // exactly once — the gate against StrictMode's double-invoked effect.
  expect(screens).toEqual(["splash", "welcome"]);

  await page.goto("/register");
  await expect(page.getByRole("heading", { name: /sign up for wingman/i })).toBeVisible();
  await page.screenshot({
    path: `${EVIDENCE}/register-screen-tracked.png`,
    fullPage: true,
  });

  // Submitted empty on purpose: the tap is recorded before validation, so the
  // abandoned form the server never hears about is still in the funnel.
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page.getByText(/at least 8/i)).toBeVisible();

  const before = captured.batches.length;
  await flushByHidingTab(page);
  await expect.poll(() => captured.batches.length).toBeGreaterThan(before);

  const secondLoad = captured.batches.slice(before).flatMap((batch) => batch.events);
  expect(secondLoad).toContainEqual({
    type: "SCREEN_VIEWED",
    payload: { screen: "register", client: "web" },
  });
  expect(secondLoad).toContainEqual({
    type: "CTA_TAPPED",
    payload: { screen: "register", action: "register_submitted", client: "web" },
  });

  // The endpoint took them: nothing was dropped, so every payload parsed
  // against its schema on the server too.
  for (const response of captured.responses) {
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ dropped: 0 });
  }
});

test("a pre-auth batch is anonymous and carries no identifying content", async ({ page }) => {
  const captured = captureTelemetry(page);

  await page.goto("/register");
  await page.getByLabel("Email").fill("someone@campus.example.com");
  await page.getByRole("button", { name: /get started/i }).click();
  await flushByHidingTab(page);
  await expect.poll(() => captured.batches.length).toBeGreaterThan(0);

  for (const batch of captured.batches) {
    // Anonymous, and never both — the stitch docs/adr/0038 rejects.
    expect(batch.anonSessionId).toBeTruthy();
    expect(batch.userId).toBeUndefined();
  }

  // The typed email is nowhere in what was sent, and neither is any other
  // free text: every payload field is a member of a closed enum.
  const serialized = JSON.stringify(captured.batches);
  expect(serialized).not.toContain("someone@campus.example.com");
  expect(serialized).not.toContain("campus.example.com");

  await page.screenshot({
    path: `${EVIDENCE}/anonymous-batch.png`,
    fullPage: true,
  });
});
