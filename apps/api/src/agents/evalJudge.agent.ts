import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { NegotiationMessage } from "@wingman/shared";
import { runAgentQuery } from "./agentSdkClient";
import { createSaveScoreTool } from "./tools/saveScore";

// Independent third-party compatibility judge for Track 2 (issue #250). Reads
// a completed negotiation transcript it never participated in and gives its
// own 1-10 score — distinct from scoreA/scoreB, which are each negotiating
// agent's own self-report. Surfacing the transcript to a judge (and to the
// dashboard) closes the gap docs/adr/0007 calls out: "no end user reads the
// transcript — only developers, via the eval dashboard."
const JUDGE_SYSTEM_PROMPT = "Prompt redacted in the public showcase version.";

export interface JudgeResult {
  score: number;
  rationale: string;
  costUsd: number;
  durationMs: number;
}

function formatTranscript(log: NegotiationMessage[]): string {
  return log.map((message) => `${message.speaker}: ${message.content}`).join("\n\n");
}

export async function judgeNegotiation(
  deliberationLog: NegotiationMessage[],
  model: string
): Promise<JudgeResult> {
  let captured: { score: number; rationale: string } | null = null;
  const saveScoreTool = createSaveScoreTool((input) => {
    captured = input;
  });
  const server = createSdkMcpServer({ name: "wingman", tools: [saveScoreTool] });

  const prompt = `Transcript:\n\n${formatTranscript(deliberationLog)}\n\nCall saveScore now with your independent 1-10 compatibility score for this pair and a one-sentence rationale.`;

  const { costUsd, durationMs } = await runAgentQuery({
    logLabel: "EvalJudge",
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    prompt,
    model,
    mcpServers: { wingman: server },
    allowedTools: ["mcp__wingman__saveScore"],
    maxTurns: 3,
    // Eval-only grader: no user is in scope, so the row is attributed to the
    // actor alone (docs/adr/0038, #553).
    audit: { actor: "evalJudge", purpose: "eval_judgement", userId: null },
  });

  if (!captured) {
    throw new Error("EvalJudge: model did not call saveScore");
  }

  const result: { score: number; rationale: string } = captured;
  return { score: result.score, rationale: result.rationale, costUsd, durationMs };
}
