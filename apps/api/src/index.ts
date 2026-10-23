import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { app } from "./app";
import { startOrchestrationLoop } from "./services/orchestration.service";
import { startDecisionResolverLoop } from "./services/decision.service";
import { startFollowUpLoop } from "./services/followup.service";
import { retentionDays, startAuditRetentionLoop } from "./services/auditRetention.service";

const PORT = process.env.PORT ?? 3001;

// Local testing escape hatch: with a large seeded population the periodic
// match sweep stampedes the Anthropic rate limit and (via the orchestration
// lock) starves the manual "Trigger Match Now" button. Set DISABLE_MATCH_LOOP=true
// in a local .env to run matches on demand only. The manual trigger and the
// Phase-2-completion first-cycle trigger are unaffected — only the interval
// sweep is suppressed. Defaults to on, so shared/deployed behavior is unchanged.
const matchLoopDisabled = process.env.DISABLE_MATCH_LOOP === "true";

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  if (matchLoopDisabled) {
    console.log(
      "Automatic match loop DISABLED (DISABLE_MATCH_LOOP=true) — matches run only via manual trigger."
    );
  } else {
    startOrchestrationLoop();
    console.log(
      `Orchestration loop started (cooldown: ${process.env.MATCH_COOLDOWN_MINUTES ?? "1"}m)`
    );
  }
  startDecisionResolverLoop();
  startFollowUpLoop();
  // The fourth recurring timer in this process (docs/adr/0038). It runs far
  // less often than the other three and skips its tick entirely while a match
  // cycle holds the orchestration lock.
  startAuditRetentionLoop();
  console.log(`Audit retention sweep started (retention: ${retentionDays()}d)`);
  console.log(
    `Decision + follow-up resolvers started (window: ${process.env.MATCH_COOLDOWN_MINUTES ?? "1"}m)`
  );
});
