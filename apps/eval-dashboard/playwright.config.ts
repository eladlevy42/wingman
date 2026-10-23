import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

// The suite mocks every /api/eval/* call and window.EventSource (see e2e/*)
// so it never depends on the real api server's DB state or a live LLM call —
// but the api server itself still needs to be up to serve the app shell's
// initial /api/health-adjacent calls and so a developer can point this suite
// at a real backend later without reconfiguring it.
export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:5174",
    headless: true,
    // Optional escape hatch for environments with a pre-installed browser at
    // a fixed, non-standard path (e.g. a sandboxed CI runner) instead of one
    // `playwright install` manages — unset by default everywhere else.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  webServer: [
    {
      command: "pnpm db:push && pnpm --filter @wingman/api dev",
      cwd: repoRoot,
      url: "http://localhost:3001/api/health",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @wingman/eval-dashboard dev",
      cwd: repoRoot,
      url: "http://localhost:5174",
      reuseExistingServer: true,
    },
  ],
});
