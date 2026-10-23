import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { ConsistencyVerdict, NegotiationMessage } from "@wingman/shared";
import { runAgentQuery } from "./agentSdkClient";
import { createSaveConsistencyVerdictTool } from "./tools/saveConsistencyVerdict";

// Independent auditor for Track 2. Reads the negotiation transcript and checks
// each side's score against what that side said. Prompt text is redacted.
const CONSISTENCY_JUDGE_SYSTEM_PROMPT = "Prompt redacted in the public showcase version.";

function formatTranscript(log: NegotiationMessage[]): string {
  return log.map((message) => `${message.speaker}: ${message.content}`).join("\n\n");
}

export type ConsistencyJudgeResult = ConsistencyVerdict & {
  costUsd: number;
  durationMs: number;
};

export async function judgeDealbreakerConsistency(
  deliberationLog: NegotiationMessage[],
  labelA: string,
  scoreA: number,
  labelB: string,
  scoreB: number,
  model: string
): Promise<ConsistencyJudgeResult> {
  let captured: ConsistencyVerdict | null = null;
  const saveConsistencyVerdictTool = createSaveConsistencyVerdictTool((input) => {
    captured = input;
  });
  const server = createSdkMcpServer({ name: "wingman", tools: [saveConsistencyVerdictTool] });

  const prompt = [
    `Transcript:\n\n${formatTranscript(deliberationLog)}`,
    "",
    `Side A is ${labelA}, who self-scored ${scoreA}/10.`,
    `Side B is ${labelB}, who self-scored ${scoreB}/10.`,
    "",
    "Call saveConsistencyVerdict now with your verdict for both sides.",
  ].join("\n");

  const { costUsd, durationMs } = await runAgentQuery({
    logLabel: "ConsistencyJudge",
    systemPrompt: CONSISTENCY_JUDGE_SYSTEM_PROMPT,
    prompt,
    model,
    mcpServers: { wingman: server },
    allowedTools: ["mcp__wingman__saveConsistencyVerdict"],
    maxTurns: 3,
    // Eval-only grader: no user is in scope, so the row is attributed to the
    // actor alone (docs/adr/0038, #553).
    audit: { actor: "consistencyJudge", purpose: "dealbreaker_consistency", userId: null },
  });

  if (!captured) {
    throw new Error("ConsistencyJudge: model did not call saveConsistencyVerdict");
  }

  const result: ConsistencyVerdict = captured;
  return { ...result, costUsd, durationMs };
}
