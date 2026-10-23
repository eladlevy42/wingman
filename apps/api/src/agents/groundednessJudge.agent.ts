import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { GroundednessFlag, GroundednessJudgeInput } from "@wingman/shared";
import { runAgentQuery } from "./agentSdkClient";
import { createSaveGroundednessTool } from "./tools/saveGroundedness";

// Independent groundedness judge for Track 2 (issue #336). The whole engine's
// accuracy rests on each negotiation agent grounding its claims in its own
// human's actual profile — the negotiation prompt only *asks* it to ("answer
// truthfully, using only the profile above"), with no enforcement. An agent
// that softens or omits a dealbreaker-relevant fact produces a false-positive
// match with no automated detection. This judge reads one speaker's statements
// plus that speaker's own profile and flags factual claims the profile does not
// support. Offline measurement only — it never blocks a live negotiation.
const GROUNDEDNESS_SYSTEM_PROMPT = "Prompt redacted in the public showcase version.";

export interface GroundednessResult {
  totalClaims: number;
  ungroundedClaims: GroundednessFlag[];
  costUsd: number;
  durationMs: number;
}

function formatClaims(claims: string[]): string {
  return claims.map((claim, i) => `${i + 1}. ${claim}`).join("\n\n");
}

// Grades one speaker's negotiation statements against that speaker's own
// profile. `profileJson` must be the serialized profile the speaking agent was
// briefed with (see negotiation.agent#serializeParticipantProfile) so the judge
// checks claims against the exact same source of truth. Short-circuits with no
// API spend when the speaker made no statements (nothing to grade).
export async function judgeGroundedness(
  speakerName: string,
  profileJson: string,
  claims: string[],
  model: string
): Promise<GroundednessResult> {
  if (claims.length === 0) {
    return { totalClaims: 0, ungroundedClaims: [], costUsd: 0, durationMs: 0 };
  }

  let captured: GroundednessJudgeInput | null = null;
  const saveGroundednessTool = createSaveGroundednessTool((input) => {
    captured = input;
  });
  const server = createSdkMcpServer({ name: "wingman", tools: [saveGroundednessTool] });

  const prompt = `Profile of ${speakerName}'s human:\n\n${profileJson}\n\nStatements ${speakerName}'s agent made during the negotiation:\n\n${formatClaims(
    claims
  )}\n\nCall saveGroundedness now with your count of factual claims and any you judge unsupported by the profile above.`;

  const { costUsd, durationMs } = await runAgentQuery({
    logLabel: "GroundednessJudge",
    systemPrompt: GROUNDEDNESS_SYSTEM_PROMPT,
    prompt,
    model,
    mcpServers: { wingman: server },
    allowedTools: ["mcp__wingman__saveGroundedness"],
    maxTurns: 3,
    // Eval-only grader: no user is in scope, so the row is attributed to the
    // actor alone (docs/adr/0038, #553).
    audit: { actor: "groundednessJudge", purpose: "groundedness_check", userId: null },
  });

  if (!captured) {
    throw new Error("GroundednessJudge: model did not call saveGroundedness");
  }

  const result: GroundednessJudgeInput = captured;
  return {
    totalClaims: result.totalClaims,
    ungroundedClaims: result.ungroundedClaims,
    costUsd,
    durationMs,
  };
}

// Cross-profile groundedness judge (issue #420). The self-only judge above
// never catches an agent fabricating facts ABOUT THE OTHER human (e.g.
// calling a chef a "software engineer") — nothing consults the other side's
// profile. This pass grades one speaker's claims ABOUT THE OTHER human
// against that other human's own profile. Offline measurement only.
const CROSS_GROUNDEDNESS_SYSTEM_PROMPT = "Prompt redacted in the public showcase version.";

// Grades `speakerName`'s claims ABOUT `otherName` against `otherName`'s own
// profile (issue #420). `otherProfileJson` must be the other human's
// serialized profile — the same source of truth that human's own agent was
// briefed with. Short-circuits with no API spend when the speaker made no
// statements (nothing to grade).
export async function judgeCrossGroundedness(
  speakerName: string,
  otherName: string,
  otherProfileJson: string,
  claims: string[],
  model: string
): Promise<GroundednessResult> {
  if (claims.length === 0) {
    return { totalClaims: 0, ungroundedClaims: [], costUsd: 0, durationMs: 0 };
  }

  let captured: GroundednessJudgeInput | null = null;
  const saveGroundednessTool = createSaveGroundednessTool((input) => {
    captured = input;
  });
  const server = createSdkMcpServer({ name: "wingman", tools: [saveGroundednessTool] });

  const prompt = `Profile of ${otherName} (the human ${speakerName}'s agent was negotiating WITH, not speaking for):\n\n${otherProfileJson}\n\nStatements ${speakerName}'s agent made during the negotiation:\n\n${formatClaims(
    claims
  )}\n\nCall saveGroundedness now with your count of factual claims about ${otherName} and any you judge unsupported by ${otherName}'s profile above.`;

  const { costUsd, durationMs } = await runAgentQuery({
    logLabel: "CrossGroundednessJudge",
    systemPrompt: CROSS_GROUNDEDNESS_SYSTEM_PROMPT,
    prompt,
    model,
    mcpServers: { wingman: server },
    allowedTools: ["mcp__wingman__saveGroundedness"],
    maxTurns: 3,
    // Eval-only grader: no user is in scope, so the row is attributed to the
    // actor alone (docs/adr/0038, #553).
    audit: { actor: "groundednessJudge", purpose: "groundedness_check", userId: null },
  });

  if (!captured) {
    throw new Error("CrossGroundednessJudge: model did not call saveGroundedness");
  }

  const result: GroundednessJudgeInput = captured;
  return {
    totalClaims: result.totalClaims,
    ungroundedClaims: result.ungroundedClaims,
    costUsd,
    durationMs,
  };
}
