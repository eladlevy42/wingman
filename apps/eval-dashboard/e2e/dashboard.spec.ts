import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(__dirname, "../../../docs/evidence/250-standalone-eval-dashboard");

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const NEW_RUN_ID = "22222222-2222-2222-2222-222222222222";

function baseConfig() {
  return { barneyModel: "sonnet", judgeModel: "sonnet" };
}

const COMPLETED_RUN = {
  id: RUN_ID,
  track: 1,
  status: "completed",
  config: baseConfig(),
  costUsd: 0,
  durationMs: 1200,
  createdAt: "2026-07-10T12:00:00.000Z",
  updatedAt: "2026-07-10T12:00:01.200Z",
  result: {
    meanPrecision: 0.6,
    perUser: [
      {
        userId: "00000000-0000-0000-0000-000000000001",
        expected: ["00000000-0000-0000-0000-0000000000aa"],
        actual: ["00000000-0000-0000-0000-0000000000aa"],
        precision: 1,
        costUsd: 0,
        durationMs: 12,
      },
      {
        userId: "00000000-0000-0000-0000-000000000002",
        expected: ["00000000-0000-0000-0000-0000000000bb"],
        actual: ["00000000-0000-0000-0000-0000000000cc"],
        precision: 0.2,
        costUsd: 0,
        durationMs: 15,
      },
    ],
  },
  error: null,
};

const FAILED_RUN = {
  id: NEW_RUN_ID,
  track: 1,
  status: "failed",
  config: baseConfig(),
  costUsd: 0,
  durationMs: 50,
  createdAt: "2026-07-10T12:05:00.000Z",
  updatedAt: "2026-07-10T12:05:00.050Z",
  result: null,
  error: "Eval requires exactly 500 WAITING users — found 3.",
};

// Mocks every /api/eval/* call the dashboard makes. route.fulfill does not
// reliably intercept requests through the Vite dev proxy (see apps/web's
// waiting.spec.ts for the same workaround), so this patches window.fetch
// directly via an init script instead.
async function mockEvalApi(
  page: Page,
  opts: {
    historyByTrack: Record<number, unknown[]>;
    runsById: Record<string, unknown>;
    startResponse?: unknown;
  }
) {
  await page.addInitScript((opts) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      const method = init?.method ?? "GET";

      const historyMatch = url.match(/\/api\/eval\/runs\?track=(\d+)/);
      if (historyMatch && method === "GET") {
        const track = Number(historyMatch[1]);
        const body = opts.historyByTrack[track] ?? [];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (/\/api\/eval\/runs$/.test(url) && method === "POST") {
        return new Response(JSON.stringify(opts.startResponse), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      const detailMatch = url.match(/\/api\/eval\/runs\/([^/]+)$/);
      if (detailMatch && method === "GET") {
        const run = opts.runsById[detailMatch[1]];
        if (run) {
          return new Response(JSON.stringify(run), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      return realFetch(input, init);
    };
  }, opts);
}

// Fakes window.EventSource so the live-progress SSE stream (see api.ts's
// subscribeToRun) is driven by the test instead of a timer. The instance exposes
// window.__evalEmit so the test emits each progress event exactly when it's ready
// to assert on it. An earlier version auto-played events 30ms apart, which left
// "Case 1 of 3" in the DOM only for the gap between the case and terminal events
// (the terminal event unmounts the panel via setActiveRun(null)) — that raced the
// assertion and flaked under full-suite load (#286).
type EvalWindow = Window & { __evalEmit?: (data: unknown) => void };

async function installEventSource(page: Page) {
  await page.addInitScript(() => {
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor(public url: string) {
        (window as EvalWindow).__evalEmit = (data) =>
          this.onmessage?.({ data: JSON.stringify(data) });
      }
      close() {}
    }
    // @ts-expect-error -- test double, not a full EventSource implementation
    window.EventSource = FakeEventSource;
  });
}

test("track switcher shows each track's name and description", async ({ page }) => {
  await mockEvalApi(page, { historyByTrack: { 1: [], 2: [], 3: [] }, runsById: {} });
  await page.goto("/");

  await expect(page.getByRole("tab", { name: "Track 1" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/deterministic matcher accuracy/i)).toBeVisible();

  await page.getByRole("tab", { name: "Track 2" }).click();
  await expect(page.getByText(/agent-to-agent negotiation/i)).toBeVisible();

  await page.getByRole("tab", { name: "Track 3" }).click();
  await expect(page.getByText(/seeded interview transcripts/i)).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/01-track-switcher.png`, fullPage: true });
});

test("reopens a completed run from history and expands a case card", async ({ page }) => {
  await mockEvalApi(page, {
    historyByTrack: { 1: [COMPLETED_RUN], 2: [], 3: [] },
    runsById: { [RUN_ID]: COMPLETED_RUN },
  });
  await page.goto("/");

  await expect(page.getByText("mean precision 0.600")).toBeVisible();
  await expect(page.getByRole("button", { name: /export json/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /export csv/i })).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/02-history-completed-run.png`, fullPage: true });

  const firstCard = page.getByTestId("case-pass").first();
  await firstCard.click();
  await expect(firstCard.getByText("Expected")).toBeVisible();
  await expect(firstCard.getByText("Actual")).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE}/03-case-card-expanded.png`, fullPage: true });
});

test("starting a run shows live progress, then the persisted outcome", async ({ page }) => {
  await mockEvalApi(page, {
    historyByTrack: { 1: [], 2: [], 3: [] },
    runsById: { [NEW_RUN_ID]: FAILED_RUN },
    startResponse: {
      id: NEW_RUN_ID,
      track: 1,
      status: "running",
      config: baseConfig(),
      costUsd: 0,
      durationMs: 0,
      createdAt: "2026-07-10T12:05:00.000Z",
      updatedAt: "2026-07-10T12:05:00.000Z",
    },
  });
  await installEventSource(page);
  await page.goto("/");

  await page.getByTestId("run-eval").click();

  // The fake EventSource is constructed once subscribeToRun runs (after the
  // mocked POST resolves); wait for its emit hook before driving events.
  await page.waitForFunction(() => typeof (window as EvalWindow).__evalEmit === "function");

  await page.evaluate((event) => (window as EvalWindow).__evalEmit?.(event), {
    type: "case",
    index: 1,
    total: 3,
    caseCostUsd: 0,
    caseDurationMs: 12,
    totalCostUsd: 0,
    elapsedMs: 12,
    score: 0.5,
    summary: "precision 0.50 (2/4)",
  });
  await expect(page.getByText("Case 1 of 3")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/04-run-live-progress.png`, fullPage: true });

  // Only now emit the terminal event, which unmounts the live panel and shows
  // the persisted failure — so the progress assertion above can't lose the race.
  await page.evaluate((event) => (window as EvalWindow).__evalEmit?.(event), {
    type: "error",
    message: FAILED_RUN.error,
  });
  await expect(page.getByText(FAILED_RUN.error).first()).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/05-run-failed-outcome.png`, fullPage: true });
});
