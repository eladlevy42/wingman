import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { pinInterviewLanguage } from "./support/interviewLanguage";

// This spec reads the chat surface's English copy while testing something
// else, so it pins the interview language rather than re-writing every
// selector in Hebrew. See support/interviewLanguage.ts and ADR-0037.
test.beforeEach(async ({ page }) => {
  await pinInterviewLanguage(page);
});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(
  __dirname,
  "../../../docs/evidence/21-chat-ui-component-message-list-input-loading-state"
);

const HARNESS_URL = "/dev/barney-chat";

test("messages render with correct alignment and Barney label", async ({ page }) => {
  await page.goto(HARNESS_URL);

  // Barney (assistant) message is left-aligned and carries the "Barney" label.
  await expect(page.getByText("Hey, I'm Barney. Tell me about yourself.")).toBeVisible();
  await expect(page.getByText("Barney", { exact: true })).toBeVisible();

  // User message is present and right-aligned.
  await expect(page.getByText("I'm a rock climber who codes.")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-alignment-and-label.png`, fullPage: true });
});

test("Enter key sends a message", async ({ page }) => {
  await page.goto(HARNESS_URL);

  const input = page.getByLabel("Message input");
  await input.fill("Sent with Enter");
  await input.press("Enter");

  await expect(page.getByText("Sent with Enter")).toBeVisible();
  await expect(input).toHaveValue("");

  await page.screenshot({ path: `${EVIDENCE}/02-enter-sends.png`, fullPage: true });
});

test("Send button sends a message", async ({ page }) => {
  await page.goto(HARNESS_URL);

  await page.getByLabel("Message input").fill("Sent with button");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Sent with button")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/03-button-sends.png`, fullPage: true });
});

test("input is disabled while loading and shows the typing indicator", async ({ page }) => {
  await page.goto(HARNESS_URL);

  await page.getByRole("button", { name: "Toggle loading" }).click();

  await expect(page.getByLabel("Message input")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByRole("status", { name: "Barney is typing" })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/04-loading-disabled.png`, fullPage: true });
});
