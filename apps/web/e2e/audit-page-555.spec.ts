import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/555-retention-rollups-audit-page");

// The /dev/audit page (#555). Unlike the other dev-page specs, these drive the
// page against the REAL API and real rows rather than a mocked route — the
// thing worth proving is that the correlationId join and the cost totals hold
// end to end, and a mocked response would prove neither.
//
// The rows come from packages/database/scripts/seedAuditEvidence.ts, run below
// so the spec is self-contained on a fresh checkout. That script is idempotent
// and scoped to one fake user id, so re-running it changes nothing else.

const SEEDED_USER = "11111111-1111-4111-8111-111111111111";
const repoRoot = path.resolve(__dirname, "../../..");

test.beforeAll(() => {
  // shell: true because the team develops on Windows, where `pnpm` is a .cmd
  // shim that execFileSync cannot spawn directly (CLAUDE.md §7).
  execFileSync("pnpm", ["--filter", "@wingman/database", "seed:audit-evidence"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
});

test("the timeline shows a user's events with the agent calls each one caused", async ({
  page,
}) => {
  await page.goto("/dev/audit");
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();

  await page.getByLabel("User id").fill(SEEDED_USER);
  await page.getByRole("button", { name: /load timeline/i }).click();

  // The events, newest first.
  await expect(page.getByRole("heading", { name: "PITCH_DECIDED" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MATCHING_STATE_CHANGED" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "INTERVIEW_TURN" })).toBeVisible();

  // The join: the pitch turn's agent call sits inside the PITCH_DECIDED card,
  // reached through correlationId and nothing else.
  const pitchCard = page.locator("article").filter({ hasText: "PITCH_DECIDED" }).first();
  await expect(pitchCard.getByText("pitch_turn")).toBeVisible();
  await expect(pitchCard.getByText("claude-sonnet-5")).toBeVisible();
  await expect(pitchCard.getByText("1 retry")).toBeVisible();

  // A sweep's call has no user action behind it and is shown separately rather
  // than dropped, so the spend on the page still adds up.
  await expect(
    page.getByRole("heading", { name: /agent calls with no user action/i })
  ).toBeVisible();

  // Metadata only: the payload's own fields are shown, and there is no message
  // or answer text anywhere, because none is stored.
  await expect(pitchCard.getByText("decision", { exact: true })).toBeVisible();
  await expect(pitchCard.getByText("yeah", { exact: true })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/timeline.png`, fullPage: true });
});

test("the cost view groups spend by day, model and actor and reconciles its total", async ({
  page,
}) => {
  await page.goto("/dev/audit");
  await page.getByRole("button", { name: /agent cost/i }).click();

  await expect(page.getByText("Total spend")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Actor" }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Model" }).first()).toBeVisible();

  // The reconciliation the AC asks for, read off the rendered page: the header
  // total is the sum of the rows shown beneath it.
  const total = Number((await page.getByTestId("total-cost").innerText()).replace("$", ""));
  const cells = await page.locator("tbody tr td:last-child").allInnerTexts();
  const summed = cells.reduce((sum, cell) => sum + Number(cell.replace("$", "")), 0);
  expect(total).toBeCloseTo(summed, 4);
  expect(total).toBeGreaterThan(0);

  await page.screenshot({ path: `${EVIDENCE}/agent-cost.png`, fullPage: true });
});
