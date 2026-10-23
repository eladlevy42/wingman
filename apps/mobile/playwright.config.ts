import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { API_URL, WEB_URL } from "./e2e/fullRunConfig";

// The apps/mobile full-run E2E (#564): two brand-new users go from sign-up to
// the debrief through Expo's web target, against the real api and REAL LLMs.
//
// THIS COSTS MONEY. Every run pays for two Barney interviews, a Sonnet
// negotiation and two pitch chats, and takes many minutes. It is deliberately
// not wired into `pnpm test:e2e` or CI: the only way in is
// `pnpm --filter @wingman/mobile test:e2e:full`.

const repoRoot = path.resolve(__dirname, "../..");
const databasePackage = path.join(repoRoot, "packages", "database");

// A fresh, unseeded SQLite file per run, so A and B are the only WAITING users
// and the match cycle can only pair them with each other. The schema's
// datasource url is hardcoded, so the schema is copied with the url rewritten
// and pushed to the copy (the same trick userDeletion.test.ts uses); the api
// then reads E2E_DATABASE_URL (packages/database/src/index.ts).
//
// Playwright evaluates this config in its workers as well as in the runner, so
// the database is only created once and the workers inherit the env var.
function prepareFreshDatabase(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wingman-mobile-e2e-"));
  const url = `file:${path.join(dir, "e2e.db").split(path.sep).join("/")}`;
  const schema = path.join(dir, "schema.prisma");
  writeFileSync(
    schema,
    readFileSync(path.join(databasePackage, "prisma", "schema.prisma"), "utf-8").replace(
      /url\s*=\s*"file:[^"]*"/,
      `url = "${url}"`
    )
  );
  const isWindows = process.platform === "win32";
  const prisma = path.join(
    databasePackage,
    "node_modules",
    ".bin",
    isWindows ? "prisma.cmd" : "prisma"
  );
  execFileSync(prisma, ["db", "push", "--schema", schema, "--skip-generate"], {
    env: { ...process.env, CHECKPOINT_DISABLE: "1" },
    stdio: "pipe",
    shell: isWindows,
  });
  return url;
}

if (!process.env.E2E_DATABASE_URL) {
  process.env.E2E_DATABASE_URL = prepareFreshDatabase();
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // One spec, two users sharing one api and one database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Real LLM turns are slow; the spec sets its own per-step timeouts.
  timeout: 60 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    headless: true,
    // A phone-sized viewport: this is the mobile app, rendered by a browser.
    viewport: { width: 430, height: 932 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // Not `dev` (tsx watch): a file save mid-run would restart the api and
      // drop the in-memory Barney sessions.
      command: "pnpm --filter @wingman/api exec tsx src/index.ts",
      cwd: repoRoot,
      url: `${API_URL}/api/health`,
      // Never reuse: an api that is already running reads the dev database,
      // not the fresh one above.
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      env: {
        E2E_DATABASE_URL: process.env.E2E_DATABASE_URL,
        // Matches only run when triggered, never on a background sweep.
        DISABLE_MATCH_LOOP: "true",
        // The first guaranteed cycle force-pairs, so reaching the pitch does not
        // depend on the negotiation scoring high enough.
        FORCE_MATCH_AFTER_SWEEPS: "0",
        // Also the follow-up loop's tick (followup.service.ts): the debrief is
        // at most a minute away once the date is moved into the past.
        MATCH_COOLDOWN_MINUTES: "1",
        DECISION_WINDOW_MINUTES: "60",
      },
    },
    {
      command: "pnpm exec expo start --web --port 8081",
      cwd: __dirname,
      url: WEB_URL,
      reuseExistingServer: false,
      // The first web bundle is built cold.
      timeout: 300_000,
      env: {
        // Without it apiBaseUrl() throws on web (there is no hostUri) and every
        // screen shows "Can't reach Wingman".
        EXPO_PUBLIC_API_URL: API_URL,
        CI: "1",
        BROWSER: "none",
      },
    },
  ],
});
