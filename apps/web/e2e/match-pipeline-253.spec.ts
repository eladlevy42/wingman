import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/253-dev-mode-match-pipeline");

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(1),
    userId: uuid(9),
    status: "EXHAUSTED",
    candidateCount: 3,
    negotiatedCount: 1,
    createdAt: "2026-07-10T12:00:00.000Z",
    completedAt: "2026-07-10T12:00:05.000Z",
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(),
    candidateScores: [
      {
        candidateId: uuid(2),
        passedHardCriteria: true,
        failureReason: null,
        overlapScore: 3,
        rank: 0,
      },
      {
        candidateId: uuid(3),
        passedHardCriteria: false,
        failureReason: "age",
        overlapScore: null,
        rank: null,
      },
      {
        candidateId: uuid(4),
        passedHardCriteria: false,
        failureReason: "gender",
        overlapScore: null,
        rank: null,
      },
    ],
    negotiations: [
      {
        matchId: uuid(101),
        candidateId: uuid(2),
        status: "REJECTED",
        scoreA: 5,
        scoreB: 6,
        deliberationLog: [
          { speaker: "Alex's agent", content: "Tell me about your ideal weekend." },
        ],
        rationale: null,
      },
    ],
    // Both fields are required (nullable, not optional) on
    // MatchAttemptDetailSchema — #339/#378 added `failure`, #307 added
    // `stoppedReason`. Omitting them makes the client-side parse throw, which
    // surfaces as an empty detail pane rather than an obvious mock error (#515).
    failure: null,
    stoppedReason: null,
    ...overrides,
  };
}

// Patches window.fetch for /api/match-attempts* — route.fulfill does not
// reliably intercept requests through the Vite dev proxy (see apps/web's
// waiting.spec.ts for the same workaround).
async function mockMatchAttemptsApi(
  page: Page,
  opts: { attempts: unknown[]; detailsById: Record<string, unknown> }
) {
  await page.addInitScript((opts) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (/\/api\/match-attempts$/.test(url)) {
        return new Response(JSON.stringify(opts.attempts), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const detailMatch = url.match(/\/api\/match-attempts\/([^/?]+)/);
      if (detailMatch) {
        const found = opts.detailsById[detailMatch[1]];
        if (found) {
          return new Response(JSON.stringify(found), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return realFetch(input, init);
    };
  }, opts);
}

test("renders history, deterministic scores, and an expandable negotiation transcript", async ({
  page,
}) => {
  await mockMatchAttemptsApi(page, {
    attempts: [summary()],
    detailsById: { [uuid(1)]: detail() },
  });

  await page.goto("/dev/match-pipeline");

  await expect(page.getByText("Match Pipeline")).toBeVisible();
  await page.locator("aside li button").first().click();

  await expect(page.getByText(`Attempt for user ${uuid(9).slice(0, 8)}`)).toBeVisible();
  await expect(page.getByText("Deterministic candidate scores (3)")).toBeVisible();
  await expect(page.getByTestId("candidate-passed")).toHaveCount(1);
  await expect(page.getByTestId("candidate-failed")).toHaveCount(2);

  await page.screenshot({ path: `${EVIDENCE}/01-attempt-detail.png`, fullPage: true });

  await expect(page.getByText("Negotiations (1)")).toBeVisible();
  await page.getByText(`A 5 · B 6`).click();
  await expect(page.getByText("Tell me about your ideal weekend.")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-negotiation-expanded.png`, fullPage: true });
});

test("polls a RUNNING attempt live until it reaches a terminal status", async ({ page }) => {
  const runningId = uuid(5);

  await page.addInitScript(
    (args) => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        if (/\/api\/match-attempts$/.test(url)) {
          return new Response(JSON.stringify(args.attempts), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes(`/api/match-attempts/${args.runningId}`)) {
          (window as unknown as { __pollCount: number }).__pollCount =
            ((window as unknown as { __pollCount: number }).__pollCount ?? 0) + 1;
          const count = (window as unknown as { __pollCount: number }).__pollCount;
          const status = count >= 2 ? "MATCHED" : "RUNNING";
          return new Response(
            JSON.stringify({ ...args.runningDetail, status, negotiatedCount: count >= 2 ? 1 : 0 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return realFetch(input, init);
      };
    },
    {
      runningId,
      attempts: [summary({ id: runningId, status: "RUNNING" })],
      runningDetail: { ...detail({ id: runningId }), negotiations: [] },
    }
  );

  await page.goto("/dev/match-pipeline");
  await page.locator("aside li button").first().click();

  await expect(page.getByText("RUNNING").first()).toBeVisible();
  await expect(page.getByText("polling…")).toBeVisible();

  await expect(page.getByText("MATCHED").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("polling…")).not.toBeVisible();
  const pollCount = await page.evaluate(
    () => (window as unknown as { __pollCount: number }).__pollCount
  );
  expect(pollCount).toBeGreaterThanOrEqual(2);

  await page.screenshot({ path: `${EVIDENCE}/03-live-poll-reaches-matched.png`, fullPage: true });
});
