import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
// The generated client directly, not the @wingman/database barrel: the barrel
// also re-exports seed data that imports ESM-only faker, which Playwright's
// CommonJS loader cannot require.
import { PrismaClient } from "../../../packages/database/generated/client";
import {
  API_URL,
  EVIDENCE_DIR,
  PITCH_QUESTIONS,
  USER_A,
  USER_B,
  type FullRunUser,
} from "./fullRunConfig";
import {
  askPitchQuestion,
  getState,
  register,
  runInterview,
  snap,
  expectEnglishInterview,
  uploadPhoto,
} from "./fullRunDriver";

// Full run of the mobile app, from sign-up to the debrief (#564).
//
// COSTS MONEY: real Barney interviews, a real Sonnet negotiation and real pitch
// chats. Run it on purpose with `pnpm --filter @wingman/mobile test:e2e:full`;
// it is kept out of `pnpm test:e2e` and CI. See playwright.config.ts for the
// api environment it runs against (fresh database, manual matching only).

interface Session {
  user: FullRunUser;
  page: Page;
  userId: string;
}

const MINUTE = 60_000;

// The same fresh database the api was started against (playwright.config.ts).
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.E2E_DATABASE_URL } },
});

async function onboard(session: Session, runId: string): Promise<void> {
  const { page, user } = session;
  session.userId = await register(page, user, runId);

  // Interviews default to Hebrew; the scripted answers are English.
  await expectEnglishInterview(page);
  await runInterview(page, user, "phase1", async () => page.url().includes("/barney/phase2"));
  await page.waitForURL("**/barney/phase2", { timeout: 2 * MINUTE });

  await runInterview(page, user, "phase2", async () =>
    page.getByTestId("photo-choose").isVisible()
  );
  await uploadPhoto(page, user);

  await expect(page.getByText("Photo saved!")).toHaveCount(0);
  await snap(page, user, "10-waiting");
  const state = await getState(page, session.userId);
  expect(state.matchingState).toBe("WAITING");
  expect(state.hasProfile).toBe(true);
  expect(state.hasPhoto).toBe(true);
}

async function orchestrationRunning(page: Page): Promise<boolean> {
  const response = await page.request.get(`${API_URL}/api/match/orchestration-status`);
  return ((await response.json()) as { running: boolean }).running;
}

// Finishing Phase 2 already kicks off a first cycle for each user, but the one
// that ran while the other was still interviewing had nobody to pair with. Wait
// for anything in flight, then trigger one more cycle if they are not matched.
async function matchUsers(a: Session, b: Session): Promise<void> {
  const deadline = Date.now() + 20 * MINUTE;
  let triggered = false;
  while (Date.now() < deadline) {
    const [stateA, stateB] = await Promise.all([
      getState(a.page, a.userId),
      getState(b.page, b.userId),
    ]);
    if (stateA.matchingState === "MATCHED" && stateB.matchingState === "MATCHED") {
      expect(stateA.matchedWith).toBe(b.userId);
      expect(stateB.matchedWith).toBe(a.userId);
      return;
    }
    if (!(await orchestrationRunning(a.page)) && !triggered) {
      const response = await a.page.request.post(`${API_URL}/api/users/${a.userId}/trigger-match`);
      expect(response.status()).toBe(202);
      triggered = ((await response.json()) as { started: boolean }).started;
    } else if (triggered && !(await orchestrationRunning(a.page))) {
      // The cycle ended; one more /state read above decides whether it matched.
      triggered = false;
    }
    await a.page.waitForTimeout(3000);
  }
  throw new Error("A and B were never matched");
}

async function pitch(session: Session, partner: FullRunUser): Promise<void> {
  const { page, user } = session;
  await page.waitForURL("**/pitch", { timeout: 2 * MINUTE });
  await expect(page.getByTestId("intro-partner-name")).toHaveText(partner.name, {
    timeout: 2 * MINUTE,
  });
  await snap(page, user, "11-match-reveal");

  await page.getByTestId("send-a-wish").click();
  await expect(page.getByTestId("questions-left")).toHaveText("3 questions left");
  await snap(page, user, "12-pitch-chat");

  for (const [index, question] of PITCH_QUESTIONS.entries()) {
    await askPitchQuestion(page, question);
    if (index === 0) {
      await expect(page.getByTestId("questions-left")).toHaveText("2 questions left");
      await snap(page, user, "13-pitch-first-answer");
    }
  }
  await expect(page.getByTestId("questions-left")).toHaveText("No questions left");
  await snap(page, user, "14-pitch-questions-spent");

  await page.getByTestId("see-who-it-is").click();
  await expect(page.getByTestId("decide-yeah")).toBeVisible();
  await expect(page.getByText(new RegExp(`Is ${partner.name}`))).toBeVisible();
  await snap(page, user, "15-decision");
}

async function chooseTimes(proposer: Session, chooser: Session): Promise<string> {
  // Proposer: up to three of the shared slate.
  const proposerPage = proposer.page;
  await expect(proposerPage.getByText("When are you free?")).toBeVisible({ timeout: MINUTE });
  const slots = proposerPage.getByTestId("time-slot");
  await expect(slots.first()).toBeVisible();
  const count = Math.min(3, await slots.count());
  for (let i = 0; i < count; i++) await slots.nth(i).click();
  await snap(proposerPage, proposer.user, "17-choose-times-proposer");
  await proposerPage.getByTestId("confirm-times").click();
  await expect(proposerPage.getByText("Times sent.")).toBeVisible({ timeout: MINUTE });
  await snap(proposerPage, proposer.user, "18-times-sent");

  // Chooser: sees exactly the proposed times once its poll picks them up.
  const chooserPage = chooser.page;
  await expect(chooserPage.getByText("Pick your date.")).toBeVisible({ timeout: 2 * MINUTE });
  await expect(chooserPage.getByTestId("time-slot")).toHaveCount(count);
  const chooserState = await getState(chooserPage, chooser.userId);
  expect(chooserState.proposedSlots).toHaveLength(count);
  await chooserPage.getByTestId("time-slot").first().click();
  await snap(chooserPage, chooser.user, "17-choose-times-chooser");
  await chooserPage.getByTestId("confirm-times").click();

  await Promise.all(
    [proposer, chooser].map((s) => s.page.waitForURL("**/blind-date", { timeout: 2 * MINUTE }))
  );
  const [timeP, timeC] = await Promise.all(
    [proposer, chooser].map(async (s) => {
      const time = s.page.getByTestId("blind-date-time");
      await expect(time).toBeVisible({ timeout: MINUTE });
      await snap(s.page, s.user, "19-blind-date");
      return (await time.textContent())?.trim() ?? "";
    })
  );
  expect(timeP).not.toBe("");
  expect(timeP).toBe(timeC);
  return timeP;
}

test("two new users go from sign-up to the debrief", async ({ browser }) => {
  mkdirSync(path.join(__dirname, EVIDENCE_DIR), { recursive: true });
  const runId = `${Date.now()}`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  // Interviews default to Hebrew and the scripted answers are English. The saved
  // language choice is a plain localStorage key on web (AsyncStorage), so it is
  // seeded before the app loads rather than toggled mid-session.
  for (const context of [contextA, contextB]) {
    await context.addInitScript(() => {
      window.localStorage.setItem("wingman.interviewLanguage", "en");
    });
  }
  const a: Session = { user: USER_A, page: await contextA.newPage(), userId: "" };
  const b: Session = { user: USER_B, page: await contextB.newPage(), userId: "" };

  await test.step("register, verify and interview both users", async () => {
    await Promise.all([onboard(a, runId), onboard(b, runId)]);
  });

  await test.step("one match cycle pairs A with B", async () => {
    await matchUsers(a, b);
  });

  await test.step("pitch: a wish, questions, and the reveal", async () => {
    await Promise.all([pitch(a, USER_B), pitch(b, USER_A)]);
  });

  await test.step("both say yeah", async () => {
    await a.page.getByTestId("decide-yeah").click();
    await expect(a.page.getByText("You said yeah.")).toBeVisible();
    await snap(a.page, a.user, "16-said-yeah");
    await b.page.getByTestId("decide-yeah").click();
    await Promise.all(
      [a, b].map((s) => s.page.waitForURL("**/choose-times", { timeout: 2 * MINUTE }))
    );
    await snap(b.page, b.user, "16-said-yeah");
  });

  await test.step("choose a time, with the roles the api rolled", async () => {
    const [stateA, stateB] = await Promise.all([
      getState(a.page, a.userId),
      getState(b.page, b.userId),
    ]);
    expect(stateA.matchingState).toBe("CHOOSING_TIMES");
    expect(stateB.matchingState).toBe("CHOOSING_TIMES");
    expect([stateA.timeRole, stateB.timeRole].sort()).toEqual(["chooser", "proposer"]);
    const [proposer, chooser] = stateA.timeRole === "proposer" ? [a, b] : [b, a];
    await chooseTimes(proposer, chooser);
  });

  await test.step("after the date, both reach the debrief", async () => {
    const { matchId } = await getState(a.page, a.userId);
    expect(matchId).toBeTruthy();
    await prisma.match.update({
      where: { id: matchId },
      data: { dateTime: new Date(Date.now() - MINUTE) },
    });

    // The follow-up loop ticks once per MATCH_COOLDOWN_MINUTES (1 minute here).
    for (const s of [a, b]) {
      await expect
        .poll(async () => (await getState(s.page, s.userId)).followUpState, {
          timeout: 3 * MINUTE,
          intervals: [5000],
        })
        .toBe("DATE_PASSED");
    }

    // The blind-date screen has no poll of its own; a relaunch routes to the debrief.
    await Promise.all(
      [a, b].map(async (s) => {
        await s.page.goto("/");
        await s.page.waitForURL("**/debrief", { timeout: MINUTE });
        await expect(s.page.getByTestId("debrief-heading")).toBeVisible({ timeout: 2 * MINUTE });
        await snap(s.page, s.user, "20-debrief");
      })
    );
  });

  await prisma.$disconnect();
  await contextA.close();
  await contextB.close();
});
