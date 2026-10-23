import type { InterviewLanguage } from "@wingman/shared";
import { runAgentQuery } from "../agentSdkClient";
import { INTERVIEW_HELPER_MODEL } from "../models";
import { addressInstruction, nameInstruction, type AddressForm } from "./localized";

// Fact nodes are pure regex extraction (no model) per docs/adr/0004 — but that
// means a user who answers with a real question ("why do you need this?")
// gets the canned probe text back, which ignores what they actually said. This
// is the one deliberate escape hatch from the deterministic flow: detect a
// question and hand that single turn to Haiku so it can actually respond,
// then return to the same pending question. Flow/state stay deterministic —
// only this turn's reply is model-generated.
const MODEL = INTERVIEW_HELPER_MODEL;

export interface SideQuestionParams {
  // The question Barney was waiting on an answer to.
  pendingQuestion: string;
  // What the user said instead of answering.
  userQuestion: string;
  // The language the reply must be written in (ADR-0037).
  language: InterviewLanguage;
  // The user being interviewed. Carried only so this helper call is attributed
  // on AgentCall (docs/adr/0038, #553); the prompt never sees it.
  userId: string;
  // How Hebrew copy addresses the person (אתה/את/אתם).
  addressForm?: AddressForm;
}

export type SideQuestionFn = (params: SideQuestionParams) => Promise<string>;

// Cheap heuristic, consistent with ADR 0004's "a few hardcoded branches
// triggered only by cheap heuristics" — a trailing "?" is a reliable enough
// signal for a POC and avoids a model call just to detect intent.
export function looksLikeQuestion(answer: string): boolean {
  return answer.trim().endsWith("?");
}

function buildSystemPrompt(): string {
  return "Prompt redacted in the public showcase version.";
}

function buildUserPrompt({
  pendingQuestion,
  userQuestion,
  language,
  addressForm,
}: SideQuestionParams): string {
  const address = addressInstruction(language, addressForm ?? "plural");
  const name = nameInstruction(language);
  return [
    `Reply language: ${language === "he" ? "Hebrew" : "English"}.`,
    ...(address ? [address] : []),
    ...(name ? [name] : []),
    `The question you asked them: "${pendingQuestion}"`,
    `What they said instead of answering: "${userQuestion}"`,
  ].join("\n");
}

export const answerSideQuestion: SideQuestionFn = async (params) => {
  const { text } = await runAgentQuery({
    logLabel: "sideQuestion",
    systemPrompt: buildSystemPrompt(),
    prompt: buildUserPrompt(params),
    model: MODEL,
    maxTurns: 1,
    audit: { actor: "interview_helper", purpose: "interview_side_question", userId: params.userId },
  });
  return text.trim();
};
