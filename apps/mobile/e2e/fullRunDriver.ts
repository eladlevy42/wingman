import path from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  API_URL,
  EVIDENCE_DIR,
  WRAPUP_ANSWER,
  type FullRunUser,
  type ScriptedAnswer,
} from "./fullRunConfig";

// Page-level steps for the full-run E2E (#564). Everything here drives the
// Expo web render of apps/mobile, so selectors are the react-native-web output:
// `testID` becomes `data-testid`, a disabled Pressable is `aria-disabled`, and a
// non-editable TextInput is `readonly`.

const MESSAGE_INPUT = "Message input";
// Section title the chat header falls back to when no tree node is pending,
// which only happens at the wrap-up ("anything else?") turn.
const WRAPUP_SECTION_TITLE = "Getting to know you";
const TURN_TIMEOUT_MS = 4 * 60_000;

export async function snap(page: Page, user: FullRunUser, step: string): Promise<void> {
  await page.screenshot({
    path: path.join(__dirname, EVIDENCE_DIR, `${user.key}-${step}.png`),
  });
}

export interface ApiState {
  matchingState: string;
  hasProfile: boolean;
  hasPhoto?: boolean;
  matchId?: string;
  matchedWith?: string;
  followUpState?: string;
  timeRole?: "proposer" | "chooser";
  candidateSlots?: string[];
  proposedSlots?: string[];
}

export async function getState(page: Page, userId: string): Promise<ApiState> {
  const response = await page.request.get(`${API_URL}/api/users/${userId}/state`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ApiState;
}

export async function storedUserId(page: Page): Promise<string> {
  const raw = await page.evaluate(() => window.localStorage.getItem("user"));
  expect(raw).not.toBeNull();
  return (JSON.parse(raw as string) as { id: string }).id;
}

export async function register(page: Page, user: FullRunUser, runId: string): Promise<string> {
  await page.goto("/register");
  await expect(page.getByTestId("register-submit")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("register-name").fill(user.name);
  await page.getByTestId("register-email").fill(`e2e-${runId}-${user.key}@example.com`);
  await page.getByTestId("register-phone").fill("050 000 0000");
  await page.getByTestId(`register-gender-${user.gender}`).click();
  await page.getByTestId("register-password").fill("full-run-password");
  await snap(page, user, "01-register");
  await page.getByTestId("register-submit").click();

  await page.waitForURL("**/verify", { timeout: 60_000 });
  await expect(page.getByTestId("verify-submit")).toBeVisible();
  await page.getByTestId("verify-university-email").fill(`e2e-${runId}-${user.key}@mail.tau.ac.il`);
  await page.getByTestId("verify-student-id").fill(`${runId}${user.key === "a" ? 1 : 2}`);
  await page.getByTestId("verify-password").fill("university-password");
  await snap(page, user, "02-verify");
  await page.getByTestId("verify-submit").click();

  await page.waitForURL("**/verified", { timeout: 60_000 });
  await expect(page.getByTestId("verified-continue")).toBeVisible();
  await snap(page, user, "03-verified");
  const userId = await storedUserId(page);
  await page.getByTestId("verified-continue").click();
  await page.waitForURL("**/barney/phase1", { timeout: 60_000 });
  return userId;
}

type Composer = "picker" | "multi" | "text" | "busy";

// What the composer is offering right now, or "busy" while a turn is in flight
// (the typing indicator is up, or every control is disabled).
async function composerState(page: Page): Promise<Composer> {
  return page.evaluate((messageInput) => {
    if (document.querySelector('[aria-label="Barney is typing"]')) return "busy";
    const select = document.querySelector("select");
    if (select) return select.disabled ? "busy" : "picker";
    const checkbox = document.querySelector('[role="checkbox"]');
    if (checkbox) return checkbox.getAttribute("aria-disabled") === "true" ? "busy" : "multi";
    const input = document.querySelector(`[aria-label="${messageInput}"]`) as
      | HTMLTextAreaElement
      | HTMLInputElement
      | null;
    if (input) return input.readOnly || input.disabled ? "busy" : "text";
    return "busy";
  }, MESSAGE_INPUT);
}

// The header's "N / T" counter and section title, read once the composer is open.
async function progress(page: Page): Promise<{ answered: number; total: number; wrapup: boolean }> {
  return page.evaluate((wrapupTitle) => {
    const texts = Array.from(document.querySelectorAll("div")).map((el) =>
      (el.textContent ?? "").trim()
    );
    let answered = -1;
    let total = -1;
    for (const value of texts) {
      const match = value.match(/^(\d+) \/ (\d+)$/);
      if (match) {
        answered = Number(match[1]) - 1;
        total = Number(match[2]);
        break;
      }
    }
    return { answered, total, wrapup: texts.includes(wrapupTitle) };
  }, WRAPUP_SECTION_TITLE);
}

async function sendText(page: Page, value: string): Promise<void> {
  await page.getByLabel(MESSAGE_INPUT).fill(value);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function answer(page: Page, scripted: ScriptedAnswer, attempt: number): Promise<void> {
  switch (scripted.kind) {
    case "picker":
      await page.locator("select").selectOption({ label: scripted.label });
      await page.getByRole("button", { name: "Confirm" }).click();
      return;
    case "choice":
      await page.getByRole("button", { name: scripted.label, exact: true }).click();
      return;
    case "multi":
      for (const label of scripted.labels) {
        await page.getByRole("checkbox", { name: label, exact: true }).click();
      }
      await page.getByRole("button", { name: scripted.confirm, exact: true }).click();
      return;
    case "text":
      // A soft node that judged the answer too thin re-asks the same field.
      // Saying more on each retry is what a real person would do.
      await sendText(
        page,
        attempt === 0
          ? scripted.text
          : `${scripted.text} To be concrete, that really is how it is for me day to day.`
      );
      return;
  }
}

// Waits until the composer is open again, or until `done` reports the phase is over.
async function waitForTurn(page: Page, done: () => Promise<boolean>): Promise<Composer | "done"> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await done()) return "done";
    const state = await composerState(page);
    if (state !== "busy") return state;
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for Barney's next turn");
}

function composerFor(scripted: ScriptedAnswer): Composer {
  if (scripted.kind === "picker") return "picker";
  if (scripted.kind === "multi") return "multi";
  return "text";
}

/**
 * Plays one interview phase to the end with the scripted answers. The tree is
 * fixed, so the engine's `answered` count says which field is being asked; a
 * probe re-asks the same count, and the answer is re-sent with more detail.
 */
export async function runInterview(
  page: Page,
  user: FullRunUser,
  phase: "phase1" | "phase2",
  done: () => Promise<boolean>
): Promise<void> {
  const script = user[phase];
  const attempts = new Map<string, number>();
  const shots = phase === "phase1" ? ["04", "05"] : ["06", "07"];
  let midShotTaken = false;

  for (let turn = 0; turn < 80; turn++) {
    const composer = await waitForTurn(page, done);
    if (composer === "done") return;
    // Let the header settle on the turn that just arrived.
    await page.waitForTimeout(300);
    const { answered, total, wrapup } = await progress(page);

    const isWrapup = wrapup && answered + 1 >= total;
    const key = isWrapup ? "wrapup" : String(answered);
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);
    if (attempt >= 5) {
      throw new Error(`${user.name} ${phase}: stuck on question ${key} after ${attempt} tries`);
    }

    if (turn === 0) await snap(page, user, `${shots[0]}-${phase}-start`);
    if (!midShotTaken && answered >= Math.floor(total / 2)) {
      midShotTaken = true;
      await snap(page, user, `${shots[1]}-${phase}-midway`);
    }

    if (isWrapup) {
      await sendText(page, WRAPUP_ANSWER);
    } else {
      const scripted = script[answered];
      if (!scripted) {
        throw new Error(`${user.name} ${phase}: no scripted answer for question ${answered}`);
      }
      // The scripted kind must match what the engine is offering. A mismatch
      // means the tree changed under the script.
      if (composer !== composerFor(scripted)) {
        throw new Error(
          `${user.name} ${phase}: question ${answered} offers "${composer}", script expects "${scripted.kind}"`
        );
      }
      await answer(page, scripted, attempt);
    }

    // Wait for the send to register (the composer closes) before looking again,
    // so the same turn is never answered twice.
    await expect
      .poll(async () => (await done()) || (await composerState(page)) === "busy", {
        timeout: 30_000,
      })
      .toBe(true);
  }
  throw new Error(`${user.name} ${phase}: interview did not finish`);
}

export async function expectEnglishInterview(page: Page): Promise<void> {
  await expect(page.getByText(/\[redacted\]/)).toBeVisible({ timeout: TURN_TIMEOUT_MS });
}

// A real JPEG, drawn in the page so the fixture needs no binary file.
async function makePhoto(page: Page, user: FullRunUser): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ initial, hue }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = `hsl(${hue}, 45%, 55%)`;
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 150px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(initial, 128, 136);
      return canvas.toDataURL("image/jpeg", 0.8);
    },
    { initial: user.name[0], hue: user.key === "a" ? 330 : 200 }
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

export async function uploadPhoto(page: Page, user: FullRunUser): Promise<void> {
  const choose = page.getByTestId("photo-choose");
  await expect(choose).toBeVisible({ timeout: TURN_TIMEOUT_MS });
  await snap(page, user, "08-photo-request");
  const buffer = await makePhoto(page, user);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), choose.click()]);
  await chooser.setFiles({ name: `${user.key}.jpg`, mimeType: "image/jpeg", buffer });
  await expect(page.getByTestId("photo-upload")).toBeVisible();
  await snap(page, user, "09-photo-selected");
  await page.getByTestId("photo-upload").click();
  await page.waitForURL("**/waiting", { timeout: 60_000 });
}

export async function askPitchQuestion(page: Page, question: string): Promise<void> {
  const input = page.getByLabel(MESSAGE_INPUT);
  await expect
    .poll(() => input.evaluate((el) => !(el as HTMLTextAreaElement).readOnly), {
      timeout: TURN_TIMEOUT_MS,
    })
    .toBe(true);
  const left = await page.getByTestId("questions-left").textContent();
  const barneyBubbles = await page.getByText("Barney", { exact: true }).count();
  await sendText(page, question);
  await expect(page.getByTestId("questions-left")).not.toHaveText(left ?? "", {
    timeout: TURN_TIMEOUT_MS,
  });
  // The reply is a new Barney bubble, fully revealed once the turn is over.
  await expect
    .poll(() => page.getByText("Barney", { exact: true }).count(), { timeout: TURN_TIMEOUT_MS })
    .toBeGreaterThan(barneyBubbles);
  await expect(page.locator('[aria-label="Barney is typing"]')).toHaveCount(0, {
    timeout: TURN_TIMEOUT_MS,
  });
}
