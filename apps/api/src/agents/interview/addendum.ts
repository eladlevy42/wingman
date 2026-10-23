import type { InterviewLanguage } from "@wingman/shared";
import { runAgentQuery } from "../agentSdkClient";
import { INTERVIEW_HELPER_MODEL } from "../models";

// One narrow Haiku call for the end-of-interview "anything else?" turn (#251).
// Per docs/adr/0004's pattern (one narrow model call per turn, no transcript
// replay): the model only decides where a substantive addendum belongs — it
// never re-runs sufficiency checks or probes, unlike a regular tree node.
const MODEL = INTERVIEW_HELPER_MODEL;

export interface AddendumFieldContext {
  field: string;
  // The question originally asked for this field.
  text: string;
  // Shape hint for soft nodes; undefined for fact nodes (deterministic, no hint).
  extractHint?: string;
  currentValue: unknown;
}

export interface AddendumParams {
  // The user's reply to "anything else you'd like to add?".
  answer: string;
  // Every field collected so far, for the model to match the reply against.
  fields: AddendumFieldContext[];
  // The language the user is being interviewed in (ADR-0037). The routing
  // decision itself is language-free, but the reply being routed is in this
  // language and any captured value must stay in the same English shape the
  // rest of the profile uses.
  language: InterviewLanguage;
  // The user being interviewed. Carried only so this helper call is attributed
  // on AgentCall (docs/adr/0038, #553); the prompt never sees it.
  userId: string;
}

export type AddendumKind = "none" | "existing_field" | "new_note";

export interface AddendumResult {
  kind: AddendumKind;
  // Only meaningful when kind === "existing_field".
  field?: string;
  // The new value for an existing field, or the note text for a new_note.
  value?: unknown;
}

export type AddendumFn = (params: AddendumParams) => Promise<AddendumResult>;

function buildSystemPrompt(): string {
  return "Prompt redacted in the public showcase version.";
}

function buildUserPrompt(params: AddendumParams): string {
  const lines = [
    `The user is being interviewed in ${params.language === "he" ? "Hebrew" : "English"}.`,
    "Already covered:",
  ];
  for (const f of params.fields) {
    const hint = f.extractHint
      ? `expected shape: ${f.extractHint}`
      : "expected shape: same type as the current value shown";
    lines.push(
      `- field "${f.field}" (asked: "${f.text}") — current value: ${JSON.stringify(f.currentValue)} (${hint})`
    );
  }
  lines.push("");
  lines.push(`Their reply to "anything else you'd like to add?": "${params.answer}"`);
  return lines.join("\n");
}

// Exported for unit testing, same rationale as softTurn's parseResult: the
// JSON tolerance and shape validation are the brittle part.
export function parseAddendumResult(text: string): AddendumResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`addendum: no JSON object in model response: ${text.slice(0, 200)}`);
  }
  // The parsed shape is validated structurally below, so an untyped parse here
  // is intentional. // explanation: external JSON from the model.
  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  if (parsed.kind !== "none" && parsed.kind !== "existing_field" && parsed.kind !== "new_note") {
    throw new Error(`addendum: malformed model response: ${text.slice(0, 200)}`);
  }
  // new_note writes straight to additionalNotes (a plain string field with no
  // tree node of its own), so it has no re-ask safety net if the model hands
  // back a non-string shape. Drop a malformed new_note to "none" here instead
  // of letting it reach finalize() as an unrecoverable value (#251 review).
  if (parsed.kind === "new_note" && typeof parsed.value !== "string") {
    return { kind: "none", field: undefined, value: undefined };
  }
  // existing_field is not safe by default either: most tree fields are
  // nullable or default to [], so a missing `value` becomes `undefined` and
  // assembles into a schema-valid null/empty value, silently overwriting a
  // previously-collected real answer with no re-ask (#272 review). Require
  // the key to be present before treating this as a real update.
  if (parsed.kind === "existing_field" && !("value" in parsed)) {
    return { kind: "none", field: undefined, value: undefined };
  }
  return {
    kind: parsed.kind,
    field: typeof parsed.field === "string" ? parsed.field : undefined,
    value: "value" in parsed ? parsed.value : undefined,
  };
}

export const routeAddendum: AddendumFn = async (params) => {
  const { text } = await runAgentQuery({
    logLabel: "addendum",
    systemPrompt: buildSystemPrompt(),
    prompt: buildUserPrompt(params),
    model: MODEL,
    maxTurns: 1,
    audit: { actor: "interview_helper", purpose: "interview_addendum", userId: params.userId },
  });
  return parseAddendumResult(text);
};
