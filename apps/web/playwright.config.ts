import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  testDir: "./e2e",
  // The whole suite shares one API server and one SQLite database, so running
  // specs in parallel makes them fight over that single backend — concurrent
  // registrations/matches contend on the DB and the shared dev server, which
  // surfaced as flaky timeouts in otherwise-deterministic tests. Serialize the
  // suite (one worker, no intra-file parallelism) so every test gets the backend
  // to itself; reliability matters more than wall-clock here (#284).
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  // Start both the API and the web app so the suite is self-contained.
  // db:push runs first so a fresh checkout has the SQLite schema in place.
  webServer: [
    {
      command: "pnpm db:push && pnpm --filter @wingman/api dev",
      cwd: repoRoot,
      url: "http://localhost:3001/api/health",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "pnpm dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
    },
  ],
});
