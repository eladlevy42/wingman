import type { InterviewLanguage } from "@wingman/shared";
import { runAgentQuery, AgentAuthError } from "../agentSdkClient";
import { createAgentSession, type QueryFn } from "../agentSdkSession";
import { INTERVIEW_HELPER_MODEL } from "../models";
import { addressInstruction, nameInstruction, type AddressForm } from "./localized";
import type { SoftNode } from "./questionTree";

// One cheap Haiku call per soft turn. See docs/adr/0004 point 4: the model does
// the voice plus one narrow judgment (sufficient?), and extraction — nothing
// more. Flow, the probe cap, and profile assembly all live in the engine.
const MODEL = INTERVIEW_HELPER_MODEL;

export interface SoftTurnParams {
  node: SoftNode;
  // The user's most recent answer to node.text.
  answer: string;
  // When true, the engine has exhausted the probe budget: the model must accept
  // the answer as-is and advance, never probe again. The cap is enforced in
  // code — this just tells the model to phrase an acknowledgment, not a probe.
  mustAdvance: boolean;
  // The language `message` must be written in (ADR-0037). It is deliberately
  // per-turn rather than per-session: the warm session's system prompt is fixed
  // for the session's whole life, so the language instruction has to travel on
  // the user prompt for the flag toggle to take effect mid-interview.
  language: InterviewLanguage;
  // How Hebrew copy addresses the person (אתה/את/אתם). Travels on the user
  // prompt for the same reason `language` does: the warm session's system
  // prompt is shared across sessions of different users.
  addressForm?: AddressForm;
  // node.text already resolved to `language`. Passed in rather than re-resolved
  // here so the model is shown the exact wording the user was shown.
  questionText: string;
  // The user being interviewed. Carried only so this helper call is attributed
  // on AgentCall (docs/adr/0038, #553); the prompt never sees it.
  userId: string;
}

export interface SoftTurnResult {
  sufficient: boolean;
  // Extracted value for node.field, shaped per node.extractHint. null when the
  // user genuinely gave nothing.
  extracted_value: unknown;
  // Barney's words back to the user: a warm acknowledgment when advancing, or a
  // probe when the answer was insufficient. The engine appends the next question
  // deterministically — the model never picks or phrases the next question.
  message: string;
}

// The real Haiku-backed implementation. The engine accepts this as an injectable
// dependency so unit tests can run the full flow without hitting the API.
export type SoftTurnFn = (params: SoftTurnParams) => Promise<SoftTurnResult>;

function buildSystemPrompt(): string {
  return "Prompt redacted in the public showcase version.";
}

function buildUserPrompt(params: SoftTurnParams): string {
  const { node, answer, mustAdvance, language, addressForm, questionText } = params;
  const address = addressInstruction(language, addressForm ?? "plural");
  const name = nameInstruction(language);
  const lines = [
    `Reply language: ${language === "he" ? "Hebrew" : "English"}.`,
    ...(address ? [address] : []),
    ...(name ? [name] : []),
    `Question: "${questionText}"`,
    `Answer: "${answer}"`,
    `Field: ${node.field}`,
    "Prompt redacted in the public showcase version.",
  ];
  if (mustAdvance) lines.push("Advance.");
  return lines.join("\n");
}

// Exported for unit testing — the JSON tolerance and shape validation are the
// brittle part of the soft turn and deserve direct coverage.
export function parseResult(text: string): SoftTurnResult {
  // Tolerate the model wrapping JSON in stray text by grabbing the first object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`softTurn: no JSON object in model response: ${text.slice(0, 200)}`);
  }
  // The parsed shape is validated structurally below, so an untyped parse here
  // is intentional. // explanation: external JSON from the model.
  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  if (typeof parsed.sufficient !== "boolean" || typeof parsed.message !== "string") {
    throw new Error(`softTurn: malformed model response: ${text.slice(0, 200)}`);
  }
  return {
    sufficient: parsed.sufficient,
    extracted_value: parsed.extracted_value ?? null,
    message: parsed.message,
  };
}

// See docs/adr/0011 — migrated off the raw Messages API onto the Claude Agent
// SDK so dev/local runs can authenticate via a Claude Code OAuth login
// instead of requiring ANTHROPIC_API_KEY. Supersedes docs/adr/0003.
// Auth-failure logging and max_tokens truncation handling now live in
// agentSdkClient's runAgentQuery, shared with BarneyAgent and NegotiationAgent.
export const runSoftTurn: SoftTurnFn = async (params) => {
  const { text } = await runAgentQuery({
    logLabel: "softTurn",
    systemPrompt: buildSystemPrompt(),
    prompt: buildUserPrompt(params),
    model: MODEL,
    maxTurns: 1,
    audit: { actor: "interview_helper", purpose: "interview_soft_turn", userId: params.userId },
  });
  return parseResult(text);
};

// A warm soft-turn runner backed by a single persistent Agent SDK session
// (agentSdkSession) instead of a fresh subprocess per call. The spawn cost is
// paid once — and, via prewarm(), even before the first soft turn so it overlaps
// the user answering the instant deterministic fact questions (#249). Every
// subsequent soft turn reuses the live subprocess and returns in ~1s (see issue
// #246). Each interview session should create exactly one of these and close()
// it when the interview ends or is evicted.
//
// The system prompt is fixed for the session's whole life (set once here); each
// turn sends only the per-answer user prompt. If the warm session ever fails
// (e.g. its subprocess dies), the turn falls back to a fresh stateless
// runAgentQuery so it still completes — an auth failure is fatal either way and
// propagates. queryImpl/fallback are injectable for tests.
export function createWarmSoftTurn(deps: {
  // The user this session interviews — every turn it runs is recorded against
  // them on AgentCall (docs/adr/0038, #553).
  userId: string;
  queryImpl?: QueryFn;
  fallback?: SoftTurnFn;
}): {
  softTurn: SoftTurnFn;
  // Eagerly spawns the warm subprocess without a model call (see #249). Called
  // at session creation so the spawn overlaps the fact-question window.
  prewarm: () => void;
  close: () => void;
} {
  const session = createAgentSession({
    logLabel: "softTurn",
    systemPrompt: buildSystemPrompt(),
    model: MODEL,
    maxTurns: 1,
    queryImpl: deps.queryImpl,
    audit: { actor: "interview_helper", purpose: "interview_soft_turn", userId: deps.userId },
  });
  const fallback = deps.fallback ?? runSoftTurn;

  const softTurn: SoftTurnFn = async (params) => {
    let text: string;
    try {
      ({ text } = await session.run(buildUserPrompt(params)));
    } catch (error) {
      // Auth failures are fatal regardless of transport — do not mask them.
      if (error instanceof AgentAuthError) throw error;
      console.error("softTurn: warm session failed, falling back to a fresh call:", error);
      return fallback(params);
    }
    // A parse failure is not a session/transport problem — let it propagate the
    // same way the stateless runSoftTurn would.
    return parseResult(text);
  };

  return { softTurn, prewarm: () => session.prewarm(), close: () => session.close() };
}
